FROM python:3.12-slim
WORKDIR /app
COPY schema.sql config.example.json ./
COPY src ./src
COPY tools ./tools
# config.json (если есть) монтируется/копируется отдельно, в образ не печём
CMD ["python", "-m", "src.pipeline", "--once", "--limit", "200"]
