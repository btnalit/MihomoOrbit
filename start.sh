#!/bin/bash

# Neko Master 启动脚本

set -e

echo "╔════════════════════════════════════════════════════════╗"
echo "║     Neko Master Traffic Statistics System              ║"
echo "╚════════════════════════════════════════════════════════╝"
echo

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 检查 pnpm
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}Error: pnpm is not installed${NC}"
    echo "Please install pnpm first: npm install -g pnpm"
    exit 1
fi

# 安装依赖
echo -e "${BLUE}[1/3] Installing dependencies...${NC}"
pnpm install

# 检查环境变量
echo
echo -e "${BLUE}[2/3] Checking environment configuration...${NC}"
if [ ! -f "apps/collector/.env" ]; then
    echo -e "${YELLOW}Warning: .env file not found in apps/collector/${NC}"
    echo "Creating from template..."
    cp apps/collector/.env.example apps/collector/.env
    echo -e "${YELLOW}Please edit apps/collector/.env with your Gateway configuration${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Environment configured${NC}"

# 启动服务
echo
echo -e "${BLUE}[3/3] Starting services...${NC}"
echo -e "${GREEN}  • Collector will run on http://localhost:3001${NC}"
echo -e "${GREEN}  • Web UI will run on http://localhost:3000${NC}"
echo
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo

# 使用 turborepo 启动所有服务
pnpm dev
