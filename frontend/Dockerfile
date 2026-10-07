FROM node:22-alpine AS build
WORKDIR /app
# vite / esbuild / tailwindcss are declared in "dependencies" of the frontend
# workspace, so a plain (non-production) install is required to build.
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . ./
RUN npm run build

FROM nginx:alpine
ENV NODE_ENV=production
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
