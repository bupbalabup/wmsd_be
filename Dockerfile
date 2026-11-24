# Local development image. Runtime secrets come from docker-compose env_file, never from the image.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "dev"]
