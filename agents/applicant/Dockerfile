FROM node:22-alpine
WORKDIR /app
COPY applicant ./applicant
COPY shared ./shared
EXPOSE 8788
CMD ["node", "applicant/server.mjs"]
