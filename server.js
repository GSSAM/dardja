const express = require('express');
const { GoogleGenAI } = require('@google/genai'); // نستخدم المكتبة الجديدة التي قمت بتثبيتها
const mime = require('mime');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ==========================================
// ⚙️ نظام تدوير المفاتيح (Key Rotation System)
// ==========================================
// جلب المفاتيح وتفكيكها إلى مصفوفة (Array)
const keysString = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || 'YOUR_API_KEY';
const apiKeys = keysString.split(',').map(key => key.trim()).filter(key => key.length > 0);

let currentKeyIndex = 0;

// دالة لاختيار المفتاح التالي بالتناوب (Round-Robin)
function getNextApiKey() {
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length; // العودة للصفر عند انتهاء القائمة
    return key;
}

// ... (دوال createWavHeader و parseMimeType تبقى كما هي بدون تغيير) ...
function createWavHeader(dataLength, options) { /* كودك السابق */ }
function parseMimeType(mimeType) { /* كودك السابق */ }

// ==========================================
// 🚀 واجهة برمجة التطبيقات (API Endpoint)
// ==========================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).send('Text is required');
    }

    try {
        // 1. سحب مفتاح مختلف لهذه العملية
        const activeKey = getNextApiKey();
        console.log(`🔑 Using Key Index: ${currentKeyIndex === 0 ? apiKeys.length - 1 : currentKeyIndex - 1}`);

        // 2. تهيئة Gemini بالمفتاح النشط
        const ai = new GoogleGenAI({ apiKey: activeKey });
        
        const config = {
            responseModalities: ["audio"],
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } }
            },
        };

        // 3. توليد الصوت
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash-tts-preview', // تأكد من اسم الموديل المتاح لك
            config: config,
            contents: [{ role: 'user', parts: [{ text: text }] }]
        });
        
        // استخراج البيانات الصوتية 
        const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
        
        if (!audioPart) throw new Error('No audio data received');

        const rawData = audioPart.inlineData.data;
        const mimeType = audioPart.inlineData.mimeType;
        const options = parseMimeType(mimeType);
        
        const audioBuffer = Buffer.from(rawData, 'base64');
        const wavHeader = createWavHeader(audioBuffer.length, options);
        const finalWav = Buffer.concat([wavHeader, audioBuffer]);

        res.set('Content-Type', 'audio/wav');
        res.send(finalWav);

    } catch (error) {
        console.error('Error generating TTS:', error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(port, () => {
    console.log(`🚀 Gemini TTS Server running at http://localhost:${port}`);
    console.log(`🛡️ Key Rotation Active: Loaded ${apiKeys.length} keys.`);
});
