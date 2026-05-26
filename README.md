# QEEP Subtitler Service

Микросервис на Node.js: получает HeyGen видео + SRT, прожигает крупные читаемые субтитры (Inter 100pt, жёлтый sweep по словам, позиция y=1200) через ffmpeg и отдаёт mp4 ссылку.

## Деплой на Render.com (бесплатно)

1. Создай GitHub репозиторий и закинь туда содержимое `subtitler-service/`:
   - `package.json`
   - `server.js`
   - `README.md`

2. Зайди на [render.com](https://render.com) → New → **Web Service**

3. Подключи GitHub репозиторий

4. Настрой:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
   - **Region**: любой ближний (Frankfurt лучше всего для России)

5. После деплоя получишь URL вида `https://qeep-subtitler-xxxx.onrender.com`

6. В Render → Settings → Environment → добавь переменную:
   - `PUBLIC_BASE_URL` = `https://qeep-subtitler-xxxx.onrender.com` (тот самый URL)
   - Redeploy

## Использование

### POST /render
```json
{
  "video_url": "https://heygen/.../video.mp4",
  "srt_url": "https://heygen/.../subs.srt"
}
```
Ответ:
```json
{ "jobId": "abc-123", "status": "pending" }
```

### GET /status/:jobId
```json
{ "status": "done", "url": "https://qeep-subtitler-xxxx.onrender.com/files/abc-123-out.mp4" }
```

### GET /health
Для прогрева холодного старта (Render free засыпает после 15 мин неактивности).

## Стиль субтитров (= JSON2Video parity)

- Шрифт: Inter 100pt bold
- Цвета: жёлтый (#FFFF00) при чтении слова, белый (#FFFFFF) для остальных
- Обводка: чёрная 12px
- Тень: чёрная 8px offset
- Позиция: центр по X (540), Y=1200 (1080×1920 canvas — выше нижней кромки)
- Макс. 4 слова в строке

## Лимиты Render Free

- 750 часов/мес — навсегда бесплатно
- Засыпает через 15 мин неактивности (cold start ~30 сек)
- 512 MB RAM, 0.5 CPU — хватает на 30-секундные видео
