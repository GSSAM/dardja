const express = require('express');
const { GoogleGenAI } = require('@google/genai'); 
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));

// =========================================================================
// ⚙️ نظام تدوير المفاتيح (Key Rotation System)
// =========================================================================
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

// =========================================================================
// 🚀 المحرك الذكي للـ TTS (نموذج المعاينة الأحدث)
// =========================================================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).send('Text is required');

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5);

    while (attempts < maxAttempts) {
        const activeKey = getNextApiKey();
        try {
            const ai = new GoogleGenAI({ apiKey: activeKey });
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-tts-preview',
                config: {
                    responseModalities: ["audio"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } } }
                },
                contents: [{ role: 'user', parts: [{ text: text }] }]
            });
            
            const audioPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
            if (!audioPart) throw new Error('No audio received');

            const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
            const wavHeader = createWavHeader(audioBuffer.length);
            const finalWav = Buffer.concat([wavHeader, audioBuffer]);

            res.set('Content-Type', 'audio/wav');
            return res.send(finalWav); 
        } catch (error) {
            attempts++;
            console.error(`⚠️ TTS Failure (Attempt ${attempts}): ${error.message}`);
            await new Promise(r => setTimeout(r, 250));
        }
    }
    if (!res.headersSent) res.status(500).json({ error: 'TTS Service Failed' });
});

// =========================================================================
// 🎓 محرك التصحيح المطور (استخدام Gemini Flash Latest)
// =========================================================================
app.post('/api/correct-bac-subject', async (req, res) => {
    const { driveUrl, subject, branchName, year, topicNumber, solutionUrl } = req.body;

    if (!driveUrl) return res.status(400).json({ error: 'driveUrl is required' });

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5) || 1;
    const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

    try {
        const topicLabel = (topicNumber == 1) ? "الموضوع الأول" : "الموضوع الثاني";
        let base64Pdf = null;
        
        const match = driveUrl.match(/\/(?:d|file\/d)\/([a-zA-Z0-9_-]+)/) || driveUrl.match(/open\?id=([a-zA-Z0-9_-]+)/);
        const fileId = match ? match[1] : null;

        if (fileId) {
            const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 35000); // مهلة 35 ثانية

            try {
                const pdfResponse = await fetch(directUrl, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (pdfResponse.ok) {
                    const arrayBuffer = await pdfResponse.arrayBuffer();
                    if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
                        return res.status(413).json({ error: "الملف كبير جداً (أقصى حد 15MB)" });
                    }
                    base64Pdf = Buffer.from(arrayBuffer).toString('base64');
                } else {
                    return res.status(502).json({ error: "فشل سحب الملف من Google Drive" });
                }
            } catch (e) {
                clearTimeout(timeoutId);
                return res.status(504).json({ error: "انتهت مهلة جلب الملف" });
            }
        }

        if (!base64Pdf) return res.status(500).json({ error: "تعذر معالجة ملف PDF" });

        const promptText = `أريدك أن تقدم تصحيحاً مفصلاً ونموذجياً لموضوع البكالوريا المرفق (PDF).
المادة: ${subject}, الشعبة: ${branchName}, السنة: ${year}.
📌 المطلوب: حل أسئلة **${topicLabel}** فقط بدقة متناهية وشرح بيداغوجي مفصل. 
استخدم LaTeX للرياضيات ($x^2$ و $$f(x)$$). التزم بأسلوب الأستاذ قاسم الصارم والدقيق.`;

        const sysInst = "أنت 'الأستاذ قاسم'، خبير تصحيح البكالوريا الجزائرية. قدم تصحيحات نموذجية تشرح المنهجية.";
        let lastError = "";

        while (attempts < maxAttempts) {
            const activeKey = getNextApiKey();
            try {
                const ai = new GoogleGenAI({ apiKey: activeKey });
                const response = await ai.models.generateContent({
                    model: 'gemini-flash-latest', // 🚀 التحديث هنا: استخدام أحدث نسخة فلاش دائماً
                    config: { systemInstruction: sysInst, temperature: 0.2 },
                    contents: [{
                        role: 'user', 
                        parts: [
                            { inlineData: { mimeType: "application/pdf", data: base64Pdf } },
                            { text: promptText }
                        ]
                    }]
                });
                
                if (!response.text) throw new Error('Empty response');
                console.log(`✅ [Correction Success] تم الحل باستخدام gemini-flash-latest`);
                return res.json({ correction: response.text });

            } catch (err) {
                attempts++;
                lastError = err.message;
                await new Promise(r => setTimeout(r, 300));
            }
        }

        if (!res.headersSent) res.status(500).json({ error: 'All keys failed', details: lastError });

    } catch (error) {
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => console.log(`🚀 Server running on port ${port} | Keys: ${apiKeys.length}`));
