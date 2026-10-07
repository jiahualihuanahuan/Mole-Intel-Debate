# Mole-Intel-Debate

Merged into [Mole-Intel](https://github.com/jiahualihuanahuan/Mole-Intel).

The web desk, company sheet, news, six seats, judge, Docker Compose, and the 00:00 America/Toronto batch all live there. vLLM is not in that Compose file. Run it yourself on the host at port 8000, served model name `qwen3.5-9b`.

```bash
git clone https://github.com/jiahualihuanahuan/Mole-Intel.git
cd Mole-Intel
docker compose up --build -d
```

Open `http://127.0.0.1:8090`.

The vLLM compose files that used to live in this repo are removed. Do not start a model container from here.
