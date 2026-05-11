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
// 🚀 المحرك الذكي للـ TTS (نص إلى كلام)
// ==========================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).send('Text is required');

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5);

    while (attempts < maxAttempts) {
        const activeKey = getNextApiKey();
        try {
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

            console.log(`✅ النجاح للـ TTS باستخدام المفتاح رقم: ${currentKeyIndex}`);
            res.set('Content-Type', 'audio/wav');
            return res.send(finalWav); 

        } catch (error) {
            attempts++;
            console.error(`⚠️ محاولة ${attempts} للـ TTS فشلت: ${error.message}. جاري تجربة مفتاح آخر...`);
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    if (!res.headersSent) {
        return res.status(500).json({ error: 'All keys failed', details: 'استنفدت جميع محاولات الربط مع خدمة الصوت' });
    }
});

// ==========================================
// 📝 المحرك الذكي للتصحيح المباشر (Multimodal PDF)
// ==========================================
app.post('/api/correct-bac-subject', async (req, res) => {
    const { driveUrl, subject, branchName, year, topicNumber, solutionUrl } = req.body;

    if (!driveUrl) {
        return res.status(400).json({ error: 'driveUrl is required' });
    }

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5) || 1;
    const MAX_FILE_SIZE = 12 * 1024 * 1024; // حماية الذاكرة: الحد الأقصى 12 ميغابايت

    try {
        const topicLabel = topicNumber === 1 ? "الموضوع الأول" : "الموضوع الثاني";
        let base64Pdf = null;
        
        const match = driveUrl.match(/\/(?:d|file\/d)\/([a-zA-Z0-9_-]+)/) || driveUrl.match(/open\?id=([a-zA-Z0-9_-]+)/);
        const fileId = match ? match[1] : null;

        if (fileId) {
            const directExportUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
            
            // تطبيق نظام الـ AbortSignal لتجنب تعليق الاتصال (Timeout Protection)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 ثانية كحد أقصى للتحميل

            try {
                const pdfResponse = await fetch(directExportUrl, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (pdfResponse.ok) {
                    // التحقق من حجم الملف عبر ترويسة Content-Length إن وجدت
                    const contentLength = pdfResponse.headers.get('content-length');
                    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
                        return res.status(413).json({ error: "حجم ملف الامتحان يتجاوز الحد المسموح به للتحليل الفوري (12MB)." });
                    }

                    const arrayBuffer = await pdfResponse.arrayBuffer();
                    
                    // تحقق إضافي من الحجم الفعلي للـ Buffer المحمل
                    if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
                        return res.status(413).json({ error: "حجم ملف الامتحان يتجاوز الحد المسموح به للتحليل الفوري (12MB)." });
                    }

                    base64Pdf = Buffer.from(arrayBuffer).toString('base64');
                } else {
                    console.warn("Failed to fetch PDF in backend:", pdfResponse.status);
                }
            } catch (fetchError) {
                clearTimeout(timeoutId);
                console.error("Drive fetch aborted or failed:", fetchError.message);
                return res.status(504).json({ error: "انتهت مهلة الاتصال بخوادم Google Drive. يرجى المحاولة لاحقاً." });
            }
        }

        if (!base64Pdf) {
            return res.status(500).json({ error: "تعذر استخراج ملف PDF من رابط جوجل درايف عبر الخادم. تأكد من أن الرابط عام وصالح." });
        }

        const promptText = `أريدك أن تقدم تصحيحاً مفصلاً ونموذجياً لموضوع البكالوريا التالي:
المادة: ${subject}
الشعبة: ${branchName}
السنة: ${year}
${solutionUrl ? 'رابط التصحيح الوزاري المرجعي: ' + solutionUrl : ''}

📌 [توجيه حاسم]: لقد قمت بإرفاق ملف الـ PDF الفعلي لورقة الأسئلة الرسمية ضمن هذا الطلب. اقرأ محتوى الملف المرفق بدقة متناهية، وتجاهل الموضوع الآخر تماماً وركز 100% على استخراج وحل أسئلة "${topicLabel}" فقط لتجنب أي هلوسة.

[تعليمات المنهجية الصارمة]:
1. اشرح الحل خطوة بخطوة. وضح للمترشح أين تذهب النقاط، وكيف ينتقل من خطوة لأخرى رياضياً أو منطقياً.
2. استخدم رموز LaTeX للمعادلات الرياضية، مثلاً: $x^2$ للمعادلات المدمجة، و $$x^2$$ للمعادلات المستقلة.
3. اتبع أسلوب "الأستاذ قاسم" في الشرح: كن دقيقاً، صارماً في المنهجية، ومشجعاً في نفس الوقت.`;

        const sysInst = "أنت 'الأستاذ قاسم'، أستاذ جزائري مخضرم في تصحيح البكالوريا. قدم تصحيحات نموذجية مفصلة تشرح منهجية الإجابة بأسلوب أكاديمي دقيق.";

        while (attempts < maxAttempts) {
            const activeKey = getNextApiKey();
            try {
                const ai = new GoogleGenAI({ apiKey: activeKey });
                
                const response = await ai.models.generateContent({
                    model: 'gemini-1.5-flash',
                    config: {
                        systemInstruction: sysInst,
                        temperature: 0.2
                    },
                    contents: [{
                        role: 'user', 
                        parts: [
                            { inlineData: { mimeType: "application/pdf", data: base64Pdf } },
                            { text: promptText }
                        ]
                    }]
                });
                
                if (!response.text) throw new Error('No text received');

                console.log(`✅ النجاح في التصحيح باستخدام المفتاح رقم: ${currentKeyIndex}`);
                return res.json({ correction: response.text });

            } catch (apiError) {
                attempts++;
                console.error(`⚠️ محاولة ${attempts} للتصحيح فشلت: ${apiError.message}. جاري تجربة مفتاح آخر...`);
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        if (!res.headersSent) {
            return res.status(500).json({ error: 'All keys failed', details: 'استنفدت جميع محاولات الربط مع Gemini' });
        }

    } catch (error) {
        console.error('Error in /api/correct-bac-subject:', error);
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Internal Server Error: ' + error.message });
        }
    }
});

app.listen(port, () => {
    console.log(`🚀 BACFLIX TTS & Correction Server Running | Loaded ${apiKeys.length} keys.`);
});
