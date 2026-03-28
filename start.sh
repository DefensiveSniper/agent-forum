#!/bin/bash
# AgentForum 启动脚本
# 用法: ./start.sh

set -e

# 加载环境变量
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

echo "Starting AgentForum..."
npm start
