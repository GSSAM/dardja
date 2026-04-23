const express = require('express');
const { GoogleGenAI } = require('@google/genai'); 
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
let apiKeys = [];

// البحث التلقائي عن كل المفاتيح المضافة في Render
for (const [envName, envValue] of Object.entries(process.env)) {
    // التقاط أي متغير يحتوي اسمه على كلمة GEMINI_KEY
    if (envName.includes('GEMINI_KEY') && envValue && envValue !== 'YOUR_API_KEY') {
        if (envValue.includes(',')) {
            const keys = envValue.split(',').map(k => k.trim()).filter(k => k.length > 0);
            apiKeys.push(...keys);
        } else {
            apiKeys.push(envValue.trim());
        }
    }
}

// تنظيف القائمة من أي مفاتيح مكررة
apiKeys = [...new Set(apiKeys)];

let currentKeyIndex = 0;

// دالة لاختيار المفتاح التالي بالتناوب
function getNextApiKey() {
    if (apiKeys.length === 0) {
        throw new Error("No API Keys found! Please check Render Environment Variables.");
    }
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length; 
    return key;
}

// ==========================================
// 🛠️ دوال معالجة الملف الصوتي (Audio Helpers)
// ==========================================
function parseMimeType(mimeType) {
    // إعدادات افتراضية تتوافق مع مخرجات Gemini TTS
    return {
        sampleRate: 24000,
        channels: 1,
        bitDepth: 16
    };
}

function createWavHeader(dataLength, options) {
    const { sampleRate, channels, bitDepth } = options;
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
        
        // طباعة رقم المفتاح المستخدم في السجلات لتسهيل المتابعة
        const usedIndex = currentKeyIndex === 0 ? apiKeys.length - 1 : currentKeyIndex - 1;
        console.log(`🔑 Using Key Index: ${usedIndex}`);

        // 2. تهيئة Gemini بالمفتاح النشط
        const ai = new GoogleGenAI({ apiKey: activeKey });
        
        const config = {
            responseModalities: ["audio"],
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } } // صوت الأستاذ قاسم
            },
        };

        // 3. توليد الصوت بالنموذج الأحدث
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-tts-preview', // تم التحديث هنا بنجاح
            config: config,
            contents: [{ role: 'user', parts: [{ text: text }] }]
        });
        
        // 4. استخراج البيانات الصوتية وتحويلها إلى WAV
        const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
        
        if (!audioPart) throw new Error('No audio data received');

        const rawData = audioPart.inlineData.data;
        const mimeType = audioPart.inlineData.mimeType;
        const options = parseMimeType(mimeType);
        
        const audioBuffer = Buffer.from(rawData, 'base64');
        const wavHeader = createWavHeader(audioBuffer.length, options);
        const finalWav = Buffer.concat([wavHeader, audioBuffer]);

        // 5. إرسال الملف الصوتي إلى منصة BACFLIX
        res.set('Content-Type', 'audio/wav');
        res.send(finalWav);

    } catch (error) {
        console.error('Error generating TTS:', error.message);
        // إرجاع رسالة الخطأ لتظهر في سجلات المتصفح بدلاً من 500 غامضة
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

// ==========================================
// 🌐 تشغيل الخادم (Start Server)
// ==========================================
app.listen(port, () => {
    console.log(`🚀 Gemini TTS Server running at http://localhost:${port}`);
    console.log(`🛡️ Key Rotation Active: Loaded ${apiKeys.length} keys dynamically.`);
});
