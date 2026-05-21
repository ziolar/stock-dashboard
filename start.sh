#!/bin/bash
cd "$(dirname "$0")/backend"
echo "启动 A股股票监控服务..."
echo "访问地址：http://localhost:8080"
echo "默认账号：admin / admin123"
echo "按 Ctrl+C 停止服务"
python3 app.py
