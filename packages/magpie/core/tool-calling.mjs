// tool-calling.mjs — freebuff 直连网关的 tool calling 支持
//
// 职责：
//   1. 解析 freebuff 的 SSE 响应（含 tool_calls 聚合）
//   2. 把 OpenAI 的 tools 透传进 freebuff 的 chat body
//   3. 把 tool_calls 结果转成 OpenAI 的两种响应形态（流式 / 非流式）
//   4. DSH 消息形状归一化 + 工具配对校验
//
// ── 依据 ──────────────────────────────────────────────────────
//
// 【A】freebuff 端点的入参和出参都是标准 OpenAI 格式（抓包证实）
//   - tools[0] = { type:"function", function:{name,description,parameters} }
//   - SSE delta.tool_calls = [{index,id,type,function:{name,arguments}}]
//   - arguments 是逐字增量字符串，需按 index 聚合后拼接
//
// 【B】DSH 传给适配器的消息形状（见 Jet-Hub src/message-shape.ts）
//   - ≤0.1.6: role:'user' 内嵌 {type:'tool-result', toolCallId, content}
//   - ≥0.1.7: **一等 role:'tool' 消息，toolCallId/isError 在顶层（驼峰）**
//   - 还有 role:'developer'（只承载工具增删元数据，必须丢弃）
//
// 【C】必须做工具配对校验（见 Jet-Hub src/sse.ts resolveToolPairing）
//   - 孤儿 tool_call（有调用无结果）→ 后端 400
//   - 孤儿 tool_result（有结果无调用）→ 后端 400
//   - 一批 tool_calls 里可用的那些**必须全部**拿到结果才能保留
//   - 名称为空的 tool_call 无论配不配对都要剔除（上游 400）
//
// ⚠ 原版网关的失败模式正是【B】+【C】缺失：
//   DSH 发 role:'tool'（驼峰 toolCallId），适配器按 tool-result 块判据找结果，
//   恒不命中 → 结果 id 集合为空 → assistant 的 tool_calls 被整体剔除。
//   模型在 wire 上看不到自己调用过什么 → 表现为"提前判定对话结束"或"循环思考"。

// ─────────────────────────────────────────────────────────────
// 1. SSE 解析 + tool_calls 聚合
// ─────────────────────────────────────────────────────────────

/**
 * 解析 freebuff 的 SSE 文本，聚合出文本与 tool_calls。
 *
 * @param {string} raw 完整 SSE 文本（可能含 `: connected` 心跳行、`[DONE]`）
 * @returns {{ text: string, toolCalls: Array, finishReason: string, usage: object|null }}
 */
export function parseFreebuffSSE(raw) {
  const contentParts = []
  const calls = new Map() // index -> { id, type, name, argsStr }
  let finishReason = null
  let usage = null

  for (const line of String(raw ?? '').split('\n')) {
    // 只处理 data 行；`: connected` / `: OPENROUTER PROCESSING` 之类直接跳过
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue

    let j
    try {
      j = JSON.parse(payload)
    } catch {
      continue // 半行 / 心跳，忽略
    }

    // usage 可能出现在没有 choices 的独立分片里
    if (j?.usage) usage = j.usage

    const choice = j?.choices?.[0]
    if (!choice) continue

    const delta = choice.delta ?? {}

    // 文本增量
    if (typeof delta.content === 'string' && delta.content.length) {
      contentParts.push(delta.content)
    }

    // tool_calls 增量
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isInteger(tc?.index) ? tc.index : 0
        let cur = calls.get(idx)
        if (!cur) {
          cur = { id: '', type: 'function', name: '', argsStr: '', finished: false }
          calls.set(idx, cur)
        }
        // ⚠ 官方有 hasFinished 保护：arguments 一旦能解析成完整 JSON，
        //    后续分片全部忽略（见 orchestrator.js 的 toolCall.hasFinished）。
        //    没有这个保护，若服务端在完整 JSON 后又发了一片，
        //    拼接结果会变成非法 JSON（如 {"a":1} + {"b":2}）。
        if (cur.finished) continue

        // id / type / name 通常只在首个分片出现，后续要保留已有值
        if (tc.id) cur.id = tc.id
        if (tc.type) cur.type = tc.type
        const fn = tc.function
        if (fn) {
          if (fn.name) cur.name = fn.name
          if (typeof fn.arguments === 'string' && fn.arguments.length) {
            cur.argsStr += fn.arguments
            // 参数已构成完整 JSON 对象 → 标记完成，后续分片不再累加
            if (isParsableJsonObject(cur.argsStr)) cur.finished = true
          }
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  // 按 index 排序后转成 OpenAI 的 tool_calls 数组
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, v]) => ({
      id: v.id || `call_${idx}_${Math.random().toString(36).slice(2, 14)}`,
      type: v.type || 'function',
      function: {
        name: v.name,
        arguments: normalizeToolArguments(v.argsStr),
      },
    }))
    // 名称为空的调用是残片，上游会 400，直接丢弃
    .filter((tc) => hasUsableToolName(tc.function.name))

  const fr = toolCalls.length ? 'tool_calls' : (finishReason || 'stop')

  return {
    text: contentParts.join(''),
    toolCalls,
    finishReason: fr,
    usage,
  }
}

// ─────────────────────────────────────────────────────────────
// 2. 工具名 / arguments 的规范化
// ─────────────────────────────────────────────────────────────

/**
 * 工具名是否可用。
 *
 * 名称为空的 tool_call 会让上游 400（实证见 Jet-Hub a391dcc）。
 * 这一条对「流被截断 / 模型输出畸形」尤其重要。
 */
export function hasUsableToolName(name) {
  return typeof name === 'string' && name.trim().length > 0
}

/**
 * 判断字符串是否为**完整可解析的 JSON 对象**。
 *
 * 用于流式累加时的「已完整」判定：一旦参数构成完整对象，
 * 后续分片就不该再拼进来（官方 hasFinished 的等价实现）。
 */
export function isParsableJsonObject(raw) {
  const s = String(raw ?? '').trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return false
  try {
    const v = JSON.parse(s)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/**
 * 规范化 tool call 的 arguments 字符串。
 *
 * OpenAI 规范要求 arguments 是**对象**的 JSON 序列化：
 *   - 空串 → '{}'
 *   - 非法 JSON（流被截断）→ '{}'
 *   - null / 数组 / 标量 → '{}'
 *   - 合法对象 → 原样（保留原始字节，避免重排 key）
 */
export function normalizeToolArguments(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) return '{}'
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return '{}'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
  return trimmed
}

// ─────────────────────────────────────────────────────────────
// 3. 请求侧：把 OpenAI 的 tools 塞进 freebuff body
// ─────────────────────────────────────────────────────────────

/**
 * 把客户端的 tools / tool_choice 应用到 freebuff 的 chat body 上。
 *
 * ⚠ 关键：CHAT_TEMPLATE 自带 freebuff 官方的 16 个工具。
 *   客户端传了 tools 就必须**整体替换**，否则 32 个工具会让模型选错；
 *   客户端没传就必须**删掉**，否则模型会试图调我们实现不了的工具
 *   （read_files 之类，网关并没有执行它们的能力）。
 */
export function applyTools(t, { tools, toolChoice, parallelToolCalls } = {}) {
  if (Array.isArray(tools) && tools.length) {
    t.tools = tools
    if (toolChoice !== undefined && toolChoice !== null) {
      t.tool_choice = toolChoice
    } else {
      t.tool_choice = 'auto'
    }
    if (parallelToolCalls !== undefined) {
      t.parallel_tool_calls = parallelToolCalls
    }
  } else {
    delete t.tools
    delete t.tool_choice
    delete t.parallel_tool_calls
  }
  return t
}

// ─────────────────────────────────────────────────────────────
// 4. DSH 消息形状归一化
// ─────────────────────────────────────────────────────────────

/**
 * 判断 content 块是否为 ≤0.1.6 的 tool-result 包裹块。
 */
function isWrappedToolResult(block) {
  return (
    typeof block === 'object' && block !== null && block.type === 'tool-result'
  )
}

/**
 * 判断是否为 ≥0.1.7 的一等工具结果消息。
 */
function isToolRoleMessage(m) {
  return m?.role === 'tool'
}

/**
 * 探测整段历史的消息形状。
 *
 * ⚠ 同时出现两种形态时以 tool-role 为准：升级期会话可能前半段旧、后半段新，
 *   tool 角色是 ≥0.1.7 的权威判据。判成 legacy 会漏掉新形态的结果。
 *
 * @returns {'legacy'|'tool-role'|'none'}
 */
export function detectMessageShape(messages) {
  let sawLegacy = false
  for (const m of messages ?? []) {
    if (isToolRoleMessage(m)) return 'tool-role'
    const c = m?.content
    if (Array.isArray(c) && c.some(isWrappedToolResult)) sawLegacy = true
  }
  return sawLegacy ? 'legacy' : 'none'
}

/**
 * 把 DSH 的一等 role:'tool' 消息降级成统一的内部形状。
 *
 * 输出统一为 `{ role:'user', content:[{type:'tool-result', toolCallId, content, isError?}] }`，
 * 与 ≤0.1.6 的包裹形态一致，便于后续序列化只写一套逻辑。
 *
 * 规则：
 *   - role:'tool' → 包裹成 tool-result 块，toolCallId 取顶层（缺失时回退 source.callId）
 *   - role:'developer' → **丢弃**（只承载工具增删元数据，不是对话内容）
 *   - 其余消息**原样透传**（保持引用身份，零成本）
 *
 * ⚠ content 数组整体保留、不压平 —— 内嵌 image 块要留着做图片提升。
 */
export function normalizeHarnessMessages(messages) {
  const shape = detectMessageShape(messages)
  const hasDeveloper = (messages ?? []).some((m) => m?.role === 'developer')
  // 形态 B：assistant 上直接挂着 wire 的 tool_calls 数组
  const hasWireToolCalls = (messages ?? []).some(
    (m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  )
  if (shape !== 'tool-role' && !hasDeveloper && !hasWireToolCalls) {
    // 已经是内部形态：连数组身份都不变
    return messages
  }

  const out = []
  for (const m of messages ?? []) {
    if (m?.role === 'developer') continue

    // 形态 B：assistant.tool_calls → content 里的 tool-call 块
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const existing = Array.isArray(m.content) ? m.content : []
      const callBlocks = m.tool_calls.map((tc) => ({
        type: 'tool-call',
        id: tc?.id,
        name: tc?.function?.name ?? tc?.name,
        arguments: tc?.function?.arguments ?? tc?.arguments ?? '{}',
      }))
      // 如果原 content 是字符串，保留成 text 块
      const textBlocks =
        typeof m.content === 'string' && m.content.length
          ? [{ type: 'text', text: m.content }]
          : existing
      out.push({ ...m, content: [...textBlocks, ...callBlocks] })
      delete out[out.length - 1].tool_calls
      continue
    }

    if (!isToolRoleMessage(m)) {
      out.push(m)
      continue
    }

    const source = m.source
    const sourceCallId =
      typeof source === 'object' && source !== null ? source.callId : undefined
    const toolCallId = m.toolCallId ?? m.tool_call_id ?? sourceCallId
    const block = {
      type: 'tool-result',
      toolCallId,
      content: m.content,
    }
    if (m.isError !== undefined) block.isError = m.isError
    out.push({ role: 'user', content: [block] })
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 5. 工具配对校验（关键：防 400）
// ─────────────────────────────────────────────────────────────

/**
 * 计算哪些 tool_call / tool_result 可以安全下发。
 *
 * 三条硬规则：
 *   1. **名称为空的 tool_call** 无论配不配对都要剔除 —— 上游会 400
 *   2. **一批 tool_calls 里可用的那些，必须全部拿到结果**才能整批保留 ——
 *      部分保留会留下无结果的 tool_call，后端照样拒绝
 *   3. **tool_result 只有在对应 tool_call 被保留时才保留** —— 孤儿结果会 400
 *
 * ⚠ 支持两种输入形态：
 *   A. DSH 内部形态：assistant.content 里有 type:'tool-call' 块，
 *      user.content 里有 type:'tool-result' 块
 *   B. OpenAI wire 形态：assistant.tool_calls 数组，
 *      role:'tool' 消息带顶层 tool_call_id
 *
 * @returns {{ keepCallIds: Set<string>, keepResultIds: Set<string> }}
 */
export function resolveToolPairing(messages) {
  const normalized = normalizeHarnessMessages(messages)

  // ── 收集所有工具结果 id（两种形态都认）──
  const allResultIds = new Set()
  for (const m of normalized) {
    // 形态 B：role:'tool' + tool_call_id（可能是 normalizeHarnessMessages 之前的原始形态）
    if (m?.role === 'tool') {
      const id = m.tool_call_id ?? m.toolCallId
      if (id != null && String(id).length) allResultIds.add(String(id))
      continue
    }
    // 形态 A：user.content 里的 tool-result 块
    const c = Array.isArray(m?.content) ? m.content : []
    for (const block of c) {
      if (isWrappedToolResult(block)) {
        const id = block.toolCallId
        if (id != null && String(id).length) allResultIds.add(String(id))
      }
    }
  }

  // ── 收集所有 tool_call（两种形态都认）──
  const keepCallIds = new Set()
  for (const m of normalized) {
    if (m?.role !== 'assistant') continue

    // 形态 B：assistant.tool_calls 数组
    const wireCalls = Array.isArray(m.tool_calls) ? m.tool_calls : []
    // 形态 A：assistant.content 里的 tool-call 块
    const c = Array.isArray(m.content) ? m.content : []
    const blockCalls = c.filter(
      (b) => typeof b === 'object' && b !== null && b.type === 'tool-call',
    )

    // 统一成 { id, name } 列表
    const calls = [
      ...wireCalls.map((tc) => ({
        id: tc?.id,
        name: tc?.function?.name ?? tc?.name,
      })),
      ...blockCalls.map((b) => ({ id: b.id, name: b.name })),
    ]
    if (calls.length === 0) continue

    const usable = calls.filter((x) => hasUsableToolName(x.name))
    if (usable.length === 0) continue

    // 一批里可用的那些只有全部拿到结果才保留
    if (usable.every((x) => x.id != null && allResultIds.has(String(x.id)))) {
      for (const x of usable) keepCallIds.add(String(x.id))
    }
  }

  const keepResultIds = new Set()
  for (const id of keepCallIds) {
    if (allResultIds.has(id)) keepResultIds.add(id)
  }

  return { keepCallIds, keepResultIds }
}

// ─────────────────────────────────────────────────────────────
// 6. 响应侧：非流式
// ─────────────────────────────────────────────────────────────

/**
 * 构造非流式的 OpenAI 响应。
 *
 * ⚠ content 在纯 tool_calls 时必须是 null（不是 ""），OpenAI 规范如此。
 */
export function buildNonStreamResponse(result, modelName, credits = 0) {
  const hasTools = result.toolCalls.length > 0
  const message = {
    role: 'assistant',
    content:
      result.text && result.text.length ? result.text : hasTools ? null : '',
    ...(hasTools ? { tool_calls: result.toolCalls } : {}),
  }

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: result.usage?.prompt_tokens ?? 0,
      completion_tokens: result.usage?.completion_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
      freebuff_credits: credits,
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 7. 响应侧：流式
// ─────────────────────────────────────────────────────────────

/**
 * 把已聚合的结果重放成 OpenAI 的 SSE 流。
 *
 * ⚠ 这是「伪流式」：本地先聚合完再分片发出。用户看不到逐字输出，
 *   但格式完全正确，客户端无感知。
 */
export function writeSSEResponse(res, result, modelName, credits = 0) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const id = `chatcmpl-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id, object: 'chat.completion.chunk', created, model: modelName }
  const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)

  // 首片：role
  chunk({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })

  // 文本增量
  if (result.text) {
    for (let i = 0; i < result.text.length; i += 40) {
      chunk({
        ...base,
        choices: [
          { index: 0, delta: { content: result.text.slice(i, i + 40) }, finish_reason: null },
        ],
      })
    }
  }

  // tool_calls：每个调用发一片完整信息
  if (result.toolCalls.length) {
    result.toolCalls.forEach((tc, i) => {
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: i, id: tc.id, type: tc.type, function: tc.function },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    })
  }

  // 结束片
  chunk({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
  })

  // usage 片
  chunk({
    ...base,
    choices: [],
    usage: {
      prompt_tokens: result.usage?.prompt_tokens ?? 0,
      completion_tokens: result.usage?.completion_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
      freebuff_credits: credits,
    },
  })

  res.write('data: [DONE]\n\n')
  res.end()
}

// ─────────────────────────────────────────────────────────────
// 8. 序列化：DSH messages → freebuff wire messages
// ─────────────────────────────────────────────────────────────

/** 从 content 数组里抽纯文本 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (b.type === 'text' || typeof b === 'string'))
    .map((b) => (typeof b === 'string' ? b : (b.text ?? '')))
    .join('')
}

/**
 * 把 DSH 的消息序列转成 freebuff 能吃的 wire 格式。
 *
 * 这是整个改造的核心：DSH 的 role:'tool'（驼峰 toolCallId）
 * 必须转成 OpenAI 的 role:'tool'（下划线 tool_call_id），
 * 并且要做配对校验，否则上游 400。
 *
 * @param {Array} messages DSH 传来的 messages
 * @param {(text:string)=>any} wrapUser 包装普通 user 文本（freebuff 要 [{type:'text',text}]）
 * @returns {Array} wire 格式的 messages
 */
export function serializeMessages(messages, wrapUser) {
  const normalized = normalizeHarnessMessages(messages)
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)
  const wire = []

  for (const m of normalized) {
    // ── assistant ──
    if (m.role === 'assistant') {
      const content = Array.isArray(m.content) ? m.content : []

      // 形态 B：已经是 wire 的 tool_calls 数组 → 规范化后沿用
      const wireCalls = Array.isArray(m.tool_calls)
        ? m.tool_calls
            .filter((tc) => keepCallIds.has(String(tc?.id)))
            .map((tc) => ({
              id: String(tc.id),
              type: 'function',
              function: {
                name: String(tc.function?.name ?? tc.name ?? ''),
                arguments: normalizeToolArguments(String(tc.function?.arguments ?? '')),
              },
            }))
            .filter((tc) => hasUsableToolName(tc.function.name))
        : []

      // 形态 A：content 里的 tool-call 块 → 转成 wire 的 tool_calls
      const blockCalls = content
        .filter((b) => b && b.type === 'tool-call')
        .filter((b) => keepCallIds.has(String(b.id)))
        .map((b) => ({
          id: String(b.id),
          type: 'function',
          function: {
            name: String(b.name),
            arguments: normalizeToolArguments(String(b.arguments ?? '')),
          },
        }))
        .filter((tc) => hasUsableToolName(tc.function.name))

      const toolCalls = [...wireCalls, ...blockCalls]
      const text = contentToText(content)
      wire.push({
        role: 'assistant',
        // 正文为空且有工具调用时 content 必须为 null
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    // ── system ──
    if (m.role === 'system') {
      wire.push({ role: 'system', content: contentToText(m.content) })
      continue
    }

    // ── tool（形态 B：wire 形态的独立 tool 消息）──
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? m.toolCallId
      if (id == null || !keepResultIds.has(String(id))) continue
      let resultText = contentToText(m.content) || '(no output)'
      wire.push({
        role: 'tool',
        tool_call_id: String(id),
        content: resultText,
      })
      continue
    }

    // ── user（形态 A：content 里的 tool-result 块）──
    const content = Array.isArray(m.content) ? m.content : []
    const toolResults = content.filter(isWrappedToolResult)
    const regular = content.filter((b) => !isWrappedToolResult(b))
    const text = contentToText(m.content)

    // 常规 user 内容
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: wrapUser ? wrapUser(text) : text })
    }

    // 工具结果 → 独立 role:'tool' 消息
    for (const r of toolResults) {
      if (!keepResultIds.has(String(r.toolCallId))) continue
      let resultText = contentToText(r.content) || '(no output)'
      wire.push({
        role: 'tool',
        tool_call_id: String(r.toolCallId),
        content: resultText,
      })
    }
  }

  return wire
}

// ─────────────────────────────────────────────────────────────
// 9. 自检
// ─────────────────────────────────────────────────────────────

export function selfTest() {
  const details = []
  const check = (name, cond, got) => {
    details.push({ name, pass: !!cond, got })
    return !!cond
  }
  let ok = true
  const t = (name, cond, got) => { ok = check(name, cond, got) && ok }

  // ── SSE 解析 ──
  const sample = [
    'data: {"choices":[{"index":0,"delta":{"content":null,"role":"assistant","tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"report_project_profile","arguments":""}}]},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"status\\": "}}]},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":null,"tool_calls":[{"index":0,"function":{"arguments":"\\"ok\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ].join('\n')
  const r = parseFreebuffSSE(sample)
  t('SSE: 1 个 tool_call', r.toolCalls.length === 1, r.toolCalls.length)
  t('SSE: name 正确', r.toolCalls[0]?.function?.name === 'report_project_profile', r.toolCalls[0]?.function?.name)
  t('SSE: id 保留', r.toolCalls[0]?.id === 'call_abc', r.toolCalls[0]?.id)
  t('SSE: arguments 拼接', r.toolCalls[0]?.function?.arguments === '{"status": "ok"}', r.toolCalls[0]?.function?.arguments)
  t('SSE: finish_reason', r.finishReason === 'tool_calls', r.finishReason)

  // 纯文本
  const r2 = parseFreebuffSSE(
    'data: {"choices":[{"delta":{"role":"assistant","content":"你好"}}]}\ndata: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}\ndata: [DONE]',
  )
  t('纯文本: 内容拼接', r2.text === '你好世界', r2.text)
  t('纯文本: 无 tool_calls', r2.toolCalls.length === 0, r2.toolCalls.length)

  // 并行调用
  const r3 = parseFreebuffSSE(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"A","arguments":"{}"}}]}}]}\ndata: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"B","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
  )
  t('并行: 2 个调用', r3.toolCalls.length === 2, r3.toolCalls.length)

  // 空名调用被丢弃
  const r4 = parseFreebuffSSE(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
  )
  t('空名调用丢弃', r4.toolCalls.length === 0, r4.toolCalls.length)

  // ── arguments 规范化 ──
  t('args: 空串 → {}', normalizeToolArguments('') === '{}', normalizeToolArguments(''))
  t('args: 非法 JSON → {}', normalizeToolArguments('{broken') === '{}', normalizeToolArguments('{broken'))
  t('args: 数组 → {}', normalizeToolArguments('[1,2]') === '{}', normalizeToolArguments('[1,2]'))
  t('args: 合法对象原样', normalizeToolArguments('{"a":1}') === '{"a":1}', normalizeToolArguments('{"a":1}'))

  // ── tools 透传 ──
  const b = { tools: [{ function: { name: 'official' } }], tool_choice: 'auto' }
  applyTools(b, { tools: [{ function: { name: 'custom' } }] })
  t('tools: 整体替换', b.tools.length === 1 && b.tools[0].function.name === 'custom', b.tools[0]?.function?.name)
  applyTools(b, {})
  t('tools: 无 tools 删除', b.tools === undefined && b.tool_choice === undefined, Object.keys(b))

  // ── 消息形状探测 ──
  t('形状: tool-role', detectMessageShape([{ role: 'tool', toolCallId: 'x' }]) === 'tool-role', '')
  t('形状: legacy', detectMessageShape([{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'x' }] }]) === 'legacy', '')
  t('形状: none', detectMessageShape([{ role: 'user', content: 'hi' }]) === 'none', '')

  // ── 归一化：tool-role → tool-result 包裹 ──
  const norm = normalizeHarnessMessages([
    { role: 'user', content: 'hi' },
    { role: 'tool', toolCallId: 'c1', content: 'result', isError: false },
    { role: 'developer', content: 'meta' },
  ])
  t('归一化: developer 被丢弃', norm.length === 2, norm.length)
  t('归一化: tool→user+tool-result', norm[1]?.role === 'user' && norm[1]?.content?.[0]?.type === 'tool-result', norm[1]?.role)
  t('归一化: toolCallId 保留', norm[1]?.content?.[0]?.toolCallId === 'c1', norm[1]?.content?.[0]?.toolCallId)

  // ── 配对校验 ──
  // 完整配对
  const paired = resolveToolPairing(
    normalizeHarnessMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
    ]),
  )
  t('配对: 完整保留', paired.keepCallIds.has('c1') && paired.keepResultIds.has('c1'), [...paired.keepCallIds])

  // 孤儿 call（有调用无结果）
  const orphanCall = resolveToolPairing([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }] },
  ])
  t('配对: 孤儿 call 被剔除', orphanCall.keepCallIds.size === 0, [...orphanCall.keepCallIds])

  // 孤儿 result（有结果无调用）
  const orphanResult = resolveToolPairing(
    normalizeHarnessMessages([{ role: 'tool', toolCallId: 'c9', content: 'ok' }]),
  )
  t('配对: 孤儿 result 被剔除', orphanResult.keepResultIds.size === 0, [...orphanResult.keepResultIds])

  // 空名调用被剔除
  const noName = resolveToolPairing(
    normalizeHarnessMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: '', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
    ]),
  )
  t('配对: 空名 call 被剔除', noName.keepCallIds.size === 0, [...noName.keepCallIds])

  // ── 序列化 ──
  const wrap = (text) => [{ type: 'text', text }]
  const wire = serializeMessages(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'file content' },
    ],
    wrap,
  )
  t('序列化: 4 条', wire.length === 4, wire.length)
  t('序列化: assistant tool_calls', wire[2]?.tool_calls?.length === 1, wire[2]?.tool_calls?.length)
  t('序列化: assistant content 为 null', wire[2]?.content === null, wire[2]?.content)
  t('序列化: tool 用下划线 tool_call_id', wire[3]?.tool_call_id === 'c1', wire[3]?.tool_call_id)
  t('序列化: tool content 是字符串', typeof wire[3]?.content === 'string', typeof wire[3]?.content)
  t('序列化: user 被 wrap', Array.isArray(wire[1]?.content), typeof wire[1]?.content)

  return { ok, details }
}
