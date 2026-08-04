#!/bin/bash
# 后端代码重构脚本
# 此脚本协助将代码从旧结构迁移到新结构

set -e

echo "🚀 开始后端代码重构..."

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# ==================== 步骤 1: 备份原文件 ====================
echo -e "${YELLOW}步骤 1: 备份原文件...${NC}"

mkdir -p apps/collector/src/_legacy
cp apps/collector/src/db.ts apps/collector/src/_legacy/db.ts.bak
cp apps/collector/src/api.ts apps/collector/src/_legacy/api.ts.bak
cp apps/collector/src/realtime.ts apps/collector/src/_legacy/realtime.ts.bak
cp apps/collector/src/websocket.ts apps/collector/src/_legacy/websocket.ts.bak

echo -e "${GREEN}✓ 备份完成${NC}"

# ==================== 步骤 2: 创建基础数据库文件 ====================
echo -e "${YELLOW}步骤 2: 创建基础数据库文件...${NC}"

# 这些文件已经通过 create-new-structure.sh 创建了空文件
# 现在需要填充基础内容

echo -e "${GREEN}✓ 基础文件已创建${NC}"

# ==================== 步骤 3: 提示下一步操作 ====================
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  目录结构和基础文件准备完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "下一步手动操作:"
echo ""
echo "1. 迁移数据库连接层:"
echo "   - 查看 apps/collector/src/database/connection.ts (已创建)"
echo "   - 从 _legacy/db.ts.bak 提取表结构到 database/schema.ts"
echo ""
echo "2. 创建 Repository 基类:"
echo "   - 编辑 apps/collector/src/database/repositories/base.repository.ts"
echo ""
echo "3. 逐个迁移 Repository:"
echo "   - domain.repository.ts (从 db.ts 提取 domain 相关方法)"
echo "   - ip.repository.ts"
echo "   - backend.repository.ts"
echo "   - stats.repository.ts"
echo "   - device.repository.ts"
echo "   - ..."
echo ""
echo "4. 迁移完成后:"
echo "   - 更新 apps/collector/src/index.ts 使用新的模块"
echo "   - 删除旧的 db.ts"
echo "   - 运行测试验证"
echo ""
echo "详细指南参考: CODE_ORGANIZATION_REFACTOR.md"
