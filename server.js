const express = require('express');
const { GoogleGenAI } = require('@google/genai'); 
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ==========================================
// ⚙️ نظام تدوير المفاتيح (Key Rotation System)
// ==========================================
let apiKeys = [];
for (const [envName, envValue] of Object.entries(process.env)) {
    if (envName.includes('GEMINI_KEY') && envValue && envValue !== 'YOUR_API_KEY') {
        if (envValue.includes(',')) {
            const keys = envValue.split(',').map(k => k.trim()).filter(k => k.length > 0);
            apiKeys.push(...keys);
        } else {
            apiKeys.push(envValue.trim());
        }
    }
}
apiKeys = [...new Set(apiKeys)];
let currentKeyIndex = 0;

function getNextApiKey() {
    if (apiKeys.length === 0) throw new Error("No API Keys found!");
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length; 
    return key;
}

// ==========================================
// 🛠️ معالجة ملف الـ WAV
// ==========================================
function createWavHeader(dataLength) {
    const sampleRate = 24000;
    const channels = 1;
    const bitDepth = 16;
    const byteRate = (sampleRate * channels * bitDepth) / 8;
    const blockAlign = (channels * bitDepth) / 8;
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    return buffer;
}

// ==========================================
// 🚀 المحرك الذكي (مُعدل ليناسب طريقتك)
// ==========================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).send('Text is required');

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5); // سيحاول مع 5 مفاتيح بحد أقصى

    while (attempts < maxAttempts) {
        const activeKey = getNextApiKey();
        try {
            // استخدام نفس الطريقة التي نجحت معك
            const ai = new GoogleGenAI({ apiKey: activeKey });
            
            const config = {
                responseModalities: ["audio"],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } }
                },
            };

            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-tts-preview',
                config: config,
                contents: [{ role: 'user', parts: [{ text: text }] }]
            });
            
            const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
            if (!audioPart) throw new Error('No audio received');

            const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
            const wavHeader = createWavHeader(audioBuffer.length);
            const finalWav = Buffer.concat([wavHeader, audioBuffer]);

            console.log(`✅ النجاح باستخدام المفتاح رقم: ${currentKeyIndex}`);
            res.set('Content-Type', 'audio/wav');
            return res.send(finalWav); // إنهاء الطلب بنجاح

        } catch (error) {
            attempts++;
            console.error(`⚠️ محاولة ${attempts} فشلت: ${error.message}. جاري تجربة مفتاح آخر...`);
            // انتظار بسيط لتهدئة الضغط
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    // إذا فشلت كل المحاولات
    res.status(500).json({ error: 'All keys failed', details: 'استنفدت جميع محاولات الربط' });
});

app.listen(port, () => {
    console.log(`🚀 BACFLIX TTS Server Running | Loaded ${apiKeys.length} keys.`);
});
