#!/usr/bin/env node
// freebuff-gateway — 启动 Freebuff 直连网关
//
// 用法：
//   npx freebuff-gateway
//   FREEBUFF_GATEWAY_PORT=8938 npx freebuff-gateway
//
// 前置：需要 Freebuff 的登录凭据（官方 CLI 登录一次生成）
//   ~/.config/manicode/device-key.json
//   ~/.config/manicode/credentials.json

import '../gateway.mjs'
