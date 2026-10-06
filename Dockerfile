FROM node:20-alpine
WORKDIR /app

# Cài các dependency runtime (pg, dotenv, Supabase SDK).
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --package-lock=false

# Sao chép mã nguồn ứng dụng
COPY . .

# Cổng mặc định cho Cloud Run (Cloud Run tự inject biến môi trường PORT=8080)
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Chạy trực tiếp node server.js để nhận tín hiệu SIGTERM/SIGINT đúng chuẩn từ Cloud Run
CMD ["node", "server.js"]
