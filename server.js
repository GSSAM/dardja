const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
// زيادة حد الاستقبال إلى 25 ميغابايت لتجنب رفض الطلبات ذات البيانات الكبيرة
app.use(bodyParser.json({ limit: '25mb' }));

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
    if (apiKeys.length === 0) throw new Error("No API Keys found in environment variables!");
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    return key;
}

// =========================================================================
// 🛠️ معالجة ملف الـ WAV
// =========================================================================
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
// 🚀 المحرك الذكي للـ TTS (نص إلى كلام)
// =========================================================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).send('Text is required');

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5) || 1;
    let lastError = "";

    while (attempts < maxAttempts) {
        const activeKey = getNextApiKey();
        try {
            const ai = new GoogleGenAI({ apiKey: activeKey });
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-tts-preview',
                config: {
                    responseModalities: ["audio"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.body.voice || "Orus" } } }
                },
                contents: [{ role: 'user', parts: [{ text: text }] }]
            });

            const audioPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
            if (!audioPart) throw new Error('No audio received from model');

            const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
            const wavHeader = createWavHeader(audioBuffer.length);
            const finalWav = Buffer.concat([wavHeader, audioBuffer]);

            res.set('Content-Type', 'audio/wav');
            return res.send(finalWav);
        } catch (error) {
            attempts++;
            lastError = error.message;
            console.error(`⚠️ محاولة ${attempts} للـ TTS فشلت: ${lastError}`);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    if (!res.headersSent) {
        return res.status(500).json({ error: 'All keys failed', details: lastError });
    }
});

// =========================================================================
// 📝 خدمة استخراج الأسئلة والتصحيح (Gemini Flash Latest Edition)
// =========================================================================
app.post('/api/correct-bac-subject', async (req, res) => {
    const { driveUrl, subject, branchName, year, topicNumber, solutionUrl } = req.body;

    if (!driveUrl) return res.status(400).json({ error: 'driveUrl is required' });

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5) || 1;
    const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 ميغابايت

    try {
        const isTopicOne = (topicNumber === 1 || topicNumber === '1');
        const topicLabel = isTopicOne ? "الموضوع الأول" : "الموضوع الثاني";

        // --- وظيفة مساعدة لتحميل الملفات من قوقل درايف ---
        async function downloadFromDrive(url) {
            const match = url.match(/\/(?:d|file\/d)\/([a-zA-Z0-9_-]+)/) || url.match(/open\?id=([a-zA-Z0-9_-]+)/);
            const fileId = match ? match[1] : null;
            if (!fileId) return null;

            const directExportUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 35000);

            try {
                const pdfResponse = await fetch(directExportUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (pdfResponse.ok) {
                    const arrayBuffer = await pdfResponse.arrayBuffer();
                    if (arrayBuffer.byteLength > MAX_FILE_SIZE) return null;
                    return Buffer.from(arrayBuffer).toString('base64');
                }
                return null;
            } catch (e) {
                clearTimeout(timeoutId);
                return null;
            }
        }

        // 1. تحميل ملف الموضوع (إلزامي)
        const base64Subject = await downloadFromDrive(driveUrl);
        if (!base64Subject) return res.status(500).json({ error: "تعذر استخراج ملف الموضوع من الرابط المقدم." });

        // 2. تحميل ملف الحل الوزاري (اختياري)
        let base64Solution = null;
        if (solutionUrl) {
            base64Solution = await downloadFromDrive(solutionUrl);
            if (base64Solution) console.log("🔍 [Multi-File Mode]: تم العثور على حل وزاري وسيتم دمجه في التحليل.");
        }

        // 🎯 الـ Prompt الهندسي المزدوج (استخراج الأسئلة + الحل)
        const promptText = `أنت "الأستاذ قاسم"، خبير تصحيح البكالوريا الجزائرية.
مهمتك: توليد حل مفصل وبيداغوجي لـ "${topicLabel}" من ملف الموضوع المرفق.

${base64Solution ? "⚠️ هام جداً: لقد أرفقت لك أيضاً 'ملف الحل الوزاري الرسمي'. يجب أن تلتزم بمنهجية الحل وسلم التنقيط والنتائج النهائية الموجودة فيه حرفياً، ولكن قم بشرح الخطوات بأسلوبك البيداغوجي المفصل." : "ملاحظة: اعتمد على خبرتك في حل هذا الموضوع بدقة."}

المادة: ${subject || 'غير محدد'}
الشعبة: ${branchName || 'غير محدد'}
السنة: ${year || 'غير محدد'}

📌 [المهام المطلوبة]:
1. **استخراج نص الأسئلة:** استخرج نص التمارين والأسئلة الخاصة بـ "${topicLabel}" فقط.
2. **تقديم الحل المفصل:** قدم حلاً نموذجياً مفصلاً يشرح المنهجية لضمان العلامة الكاملة.
3. **التنسيق:** أعد إجابتك بصيغة JSON تحتوي على:
   - "questionsText": نص الأسئلة منسقاً.
   - "correction": الحل المشروح بالتفصيل.
   
استخدم LaTeX للرياضيات ($x^2$ و $$f(x)$$).`;

        const sysInst = "أنت 'الأستاذ قاسم'، خبير تصحيح البكالوريا الجزائرية. أعد إجابتك دائماً بتنسيق JSON صارم ونظيف يحتوي على questionsText و correction.";
        let lastApiError = "";

        while (attempts < maxAttempts) {
            const activeKey = getNextApiKey();
            try {
                const ai = new GoogleGenAI({ apiKey: activeKey });

                // إعداد أجزاء الرسالة (الموضوع + الحل إذا وجد + النص)
                const messageParts = [
                    { inlineData: { mimeType: "application/pdf", data: base64Subject } }
                ];

                if (base64Solution) {
                    messageParts.push({ inlineData: { mimeType: "application/pdf", data: base64Solution } });
                }

                messageParts.push({ text: promptText });

                const response = await ai.models.generateContent({
                    model: 'gemini-flash-latest',
                    config: {
                        systemInstruction: sysInst,
                        temperature: 0.1,
                        responseMimeType: "application/json"
                    },
                    contents: [{ role: 'user', parts: messageParts }]
                });

                const responseText = response.candidates[0].content.parts[0].text;
                if (!responseText) throw new Error('توليد نصي فارغ');

                const parsedResult = JSON.parse(responseText);
                if (!parsedResult.questionsText || !parsedResult.correction) {
                    throw new Error("النموذج لم يرجع الحقول المطلوبة (questionsText, correction)");
                }

                console.log(`✅ [Correction Success] تم الحل بنجاح باستخدام المصدر المزدوج: ${base64Solution ? 'نعم' : 'لا'}`);
                return res.json({
                    questionsText: parsedResult.questionsText,
                    correction: parsedResult.correction
                });
            } catch (apiError) {
                attempts++;
                lastApiError = apiError.message;
                console.error(`⚠️ محاولة #${attempts} للتصحيح المستهدف فشلت: ${lastApiError}`);
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        if (!res.headersSent) {
            return res.status(500).json({ error: 'تعذر استخراج الحل من الذكاء الاصطناعي.', details: lastApiError });
        }

    } catch (error) {
        console.error('Critical Error in /api/correct-bac-subject:', error);
        if (!res.headersSent) {
            return res.status(500).json({ error: 'خطأ داخلي: ' + error.message });
        }
    }
});

app.listen(port, () => {
    console.log(`🚀 BACFLIX Cloud AI Server Running on port ${port} | Keys: ${apiKeys.length}`);
});
