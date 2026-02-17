SketchQuest Render Deploy Paketi

1) Bu klasoru tek basina GitHub reposuna yukleyin.
2) Render Web Service olusturun.
   - Build Command: npm install
   - Start Command: node index.js
3) Render Environment Variables:
   - CLIENT_URL=https://vechiron.com
   - VECB0T_API_BASE=https://vechiron.com/api
   - SKETCHQUEST_GAME_SECRET=vecbot-sketchquest-secret

Not:
- SKETCHQUEST_GAME_SECRET ile php-api/index.php icindeki SKETCHQUEST endpoint anahtari ayni olmalidir.
- Oyunu static olarak /games/sketchquest/ altina deploy etmeye devam edin.
