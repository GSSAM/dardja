const express = require('express');
const { GoogleGenAI } = require('@google/genai'); 
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ==========================================
// ⚙️ نظام تدوير المفاتيح المتطور (Smart Failover)
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

// دالة اختيار المفتاح التالي
function getNextKey() {
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    return key;
}

// ==========================================
// 🛠️ معالجة الصوت
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
    buffer.writeUInt16LE(bitDepth === 16 ? 2 : 1, 32); // Simplified blockAlign
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    return buffer;
}

// ==========================================
// 🚀 المحرك الذكي (The Smart Engine)
// ==========================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;
    if (!text || text.trim().length === 0) return res.status(400).send('Empty text');

    // سنحاول حتى 5 مرات مع مفاتيح مختلفة قبل الاستسلام
    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5); 

    while (attempts < maxAttempts) {
        const activeKey = getNextKey();
        try {
            const ai = new GoogleGenAI({ apiKey: activeKey });
            const model = ai.getGenerativeModel({ model: "gemini-3.1-flash-tts-preview" });
            
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: text }] }],
                generationConfig: {
                    responseModalities: ["audio"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } } }
                }
            });

            const audioPart = result.response.candidates[0].content.parts.find(p => p.inlineData);
            if (!audioPart) throw new Error("No audio in response");

            const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
            const wavHeader = createWavHeader(audioBuffer.length);
            
            console.log(`✅ Success with key ${currentKeyIndex} (Attempt ${attempts + 1})`);
            res.set('Content-Type', 'audio/wav');
            return res.send(Buffer.concat([wavHeader, audioBuffer]));

        } catch (error) {
            attempts++;
            console.error(`⚠️ Key ${currentKeyIndex} failed: ${error.message}. Retrying...`);
            // انتظار بسيط جداً قبل المحاولة التالية لتجنب الصدامات
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    res.status(500).json({ error: "All keys failed after multiple attempts." });
});

app.listen(port, () => {
    console.log(`🚀 Resilient Server Live | Loaded ${apiKeys.length} keys.`);
});
