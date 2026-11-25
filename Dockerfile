FROM node:20-alpine

WORKDIR /app

# 先只拷依赖清单，装依赖能命中构建缓存
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷运行需要的两个文件
COPY server.js index.html ./

# 端口三处保持一致：这里、云托管控制台「端口」、server.js 的 PORT 默认值
# 平台若注入 PORT 会覆盖它；不注入时也有个确定值，避免健康检查连不上
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
