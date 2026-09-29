# trade-bot

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

To build a production bundle (output in `dist/`):

```bash
bun run build
bun run start:prod
```

To build and run with Docker (from the project root):

```bash
docker build -f Docker/Dockerfile -t trade-bot .
docker run --rm trade-bot   # add --env-file .env if you use one
```
