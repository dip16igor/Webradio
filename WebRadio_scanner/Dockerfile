FROM python:3.12-slim
WORKDIR /app
COPY schema.sql config.example.json ./
COPY src ./src
COPY tools ./tools
COPY public ./public
# config.json (если есть) монтируется/копируется отдельно, в образ не печём
EXPOSE 3100
CMD ["python", "-m", "src.webapi"]
