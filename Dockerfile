FROM node:20-alpine
WORKDIR /app
COPY . /app
ENV AGENTGATE_INDEX=/app/data/index.json
ENV AGENTGATE_SAMPLE=/app/data/sample-index.json
ENV AGENTGATE_HOST=0.0.0.0
ENV AGENTGATE_PORT=8080
EXPOSE 8080
CMD ["node", "bin/agentgate.mjs", "serve"]
