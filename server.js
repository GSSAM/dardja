const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const mime = require('mime');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// إعدادات الوصول وتمرير البيانات
app.use(cors());
app.use(bodyParser.json());

// إعداد مفتاح API الخاص بـ Gemini
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY');

/**
 * دالة بناء رأس ملف WAV (Header)
 * لضمان توافق الصوت مع مشغل HTML5 في المتصفح
 */
function createWavHeader(dataLength, options) {
    const { numChannels, sampleRate, bitsPerSample } = options;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const buffer = Buffer.alloc(44);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);

    return buffer;
}

/**
 * تحليل نوع بيانات الصوت المستلمة من Gemini
 */
function parseMimeType(mimeType) {
    const [fileType, ...params] = mimeType.split(';').map(s => s.trim());
    const [_, format] = fileType.split('/');
    const options = { numChannels: 1, sampleRate: 24000, bitsPerSample: 16 };

    if (format && format.startsWith('L')) {
        const bits = parseInt(format.slice(1), 10);
        if (!isNaN(bits)) options.bitsPerSample = bits;
    }

    for (const param of params) {
        const [key, value] = param.split('=').map(s => s.trim());
        if (key === 'rate') options.sampleRate = parseInt(value, 10);
    }
    return options;
}

/**
 * نقطة النهاية (API Endpoint) التي سيستدعيها المساعد "قاسم"
 */
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).send('Text is required');
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-tts-preview" });
        
        const generationConfig = {
            responseModalities: ["audio"],
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } }
            },
        };

        const result = await model.generateContent([text], generationConfig);
        const response = await result.response;
        
        // استخراج البيانات الصوتية (Base64) من استجابة Gemini
        const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
        
        if (!audioPart) {
            throw new Error('No audio data received from Gemini');
        }

        const rawData = audioPart.inlineData.data;
        const mimeType = audioPart.inlineData.mimeType;
        const options = parseMimeType(mimeType);
        
        // تحويل البيانات إلى Buffer وإضافة رأس WAV
        const audioBuffer = Buffer.from(rawData, 'base64');
        const wavHeader = createWavHeader(audioBuffer.length, options);
        const finalWav = Buffer.concat([wavHeader, audioBuffer]);

        // إرسال الملف الصوتي للمتصفح
        res.set('Content-Type', 'audio/wav');
        res.send(finalWav);

    } catch (error) {
        console.error('Error generating TTS:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(port, () => {
    console.log(`🚀 Gemini TTS Server running at http://localhost:${port}`);
});