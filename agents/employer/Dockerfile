FROM node:22-alpine
WORKDIR /app
COPY employer ./employer
COPY shared ./shared
EXPOSE 8787
CMD ["node", "employer/server.mjs"]
