const express = require('express');
const { GoogleGenAI } = require('@google/genai'); 
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ==========================================
// ⚙️ نظام تدوير المفاتيح (Key Rotation)
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

function getNextKey() {
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
// 🚀 المحرك الذكي والمقاوم للأخطاء
// ==========================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;
    if (!text || text.trim().length === 0) return res.status(400).send('Empty text');

    let attempts = 0;
    // سيحاول السيرفر مع 5 مفاتيح مختلفة قبل أن يستسلم ويرسل خطأ
    const maxAttempts = Math.min(apiKeys.length, 5); 

    while (attempts < maxAttempts) {
        const activeKey = getNextKey();
        try {
            // الطريقة المتوافقة مع إصدار المكتبة لديك
            const ai = new GoogleGenAI(activeKey); 
            
            const config = {
                responseModalities: ["audio"],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } }
                }
            };

            const response = await ai.getGenerativeModel({ model: "gemini-3.1-flash-tts-preview" }).generateContent({
                contents: [{ role: 'user', parts: [{ text: text }] }],
                generationConfig: config
            });

            const audioPart = response.response.candidates[0].content.parts.find(p => p.inlineData);
            if (!audioPart) throw new Error("No audio data");

            const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
            const wavHeader = createWavHeader(audioBuffer.length);
            
            console.log(`✅ Success | Key Index: ${currentKeyIndex} | Attempt: ${attempts + 1}`);
            res.set('Content-Type', 'audio/wav');
            return res.send(Buffer.concat([wavHeader, audioBuffer]));

        } catch (error) {
            attempts++;
            console.error(`⚠️ Attempt ${attempts} failed with Key ${currentKeyIndex}: ${error.message}`);
            // انتظار بسيط جداً قبل الانتقال للمفتاح التالي
            await new Promise(r => setTimeout(r, 150));
        }
    }

    res.status(500).json({ error: "Failover failed", details: "All attempted keys were exhausted." });
});

app.listen(port, () => {
    console.log(`🚀 BACFLIX TTS Server Live | Keys: ${apiKeys.length}`);
});
