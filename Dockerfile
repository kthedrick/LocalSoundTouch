FROM node:20-alpine
WORKDIR /app
COPY . .
RUN chmod +x /app/run.sh
EXPOSE 3000
ENTRYPOINT ["/app/run.sh"]
