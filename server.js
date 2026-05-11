const express = require('express');
const { GoogleGenAI } = require('@google/genai'); 
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// تفعيل CORS لجميع النطاقات مع دعم المعالجة الصامتة
app.use(cors());
app.use(bodyParser.json({ limit: '20mb' })); // السماح بحمولات أكبر نسبياً لتجنب رفض الطلبات

// =========================================================================
// ⚙️ نظام تدوير المفاتيح الديناميكي (Dynamic Key Rotation System)
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
// إزالة المفاتيح المكررة
apiKeys = [...new Set(apiKeys)];
let currentKeyIndex = 0;

function getNextApiKey() {
    if (apiKeys.length === 0) {
        throw new Error("⚠️ لم يتم العثور على مفاتيح API في متغيرات البيئة (Environment Variables).");
    }
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length; 
    return key;
}

// =========================================================================
// 🛠️ دوال مساعدة لمعالجة الصوت واستخراج الروابط
// =========================================================================

/**
 * إنشاء ترويسة ملف WAV الصوتي ليتوافق مع المشغلات القياسية
 */
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

/**
 * استخراج كود الملف (File ID) من روابط Google Drive المتنوعة
 */
function extractDriveFileId(url) {
    if (!url) return null;
    const match = url.match(/\/(?:d|file\/d)\/([a-zA-Z0-9_-]+)/) || url.match(/open\?id=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// =========================================================================
// 🚀 نقطة الاتصال الأولى: المحرك الذكي للـ TTS (تحويل النص إلى كلام)
// =========================================================================
app.post('/api/gemini-tts', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'النص مطلوب لتوليد الصوت' });
    }

    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5) || 1;
    let lastErrorMessage = "";

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
            
            const audioPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
            if (!audioPart) throw new Error('لم يتم استقبال بيانات صوتية من النموذج');

            const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
            const wavHeader = createWavHeader(audioBuffer.length);
            const finalWav = Buffer.concat([wavHeader, audioBuffer]);

            console.log(`✅ [TTS Success] تم التوليد بنجاح (المفتاح المستخدم: #${currentKeyIndex})`);
            res.set('Content-Type', 'audio/wav');
            return res.send(finalWav);

        } catch (error) {
            attempts++;
            lastErrorMessage = error.message;
            console.warn(`⚠️ [TTS Attempt #${attempts} Failed]: ${lastErrorMessage}`);
            // مهلة زمنية قصيرة لتجنب حظر تجاوز المعدل (Rate Limiting)
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    if (!res.headersSent) {
        return res.status(500).json({ 
            error: 'فشل توليد الصوت.', 
            details: lastErrorMessage || 'استنفدت جميع محاولات الاتصال المتاحة بالذكاء الاصطناعي.' 
        });
    }
});

// =========================================================================
// 🎓 نقطة الاتصال الثانية: خدمة التصحيح الذكي المباشر (Multimodal PDF Vision)
// =========================================================================
app.post('/api/correct-bac-subject', async (req, res) => {
    const { driveUrl, subject, branchName, year, topicNumber, solutionUrl } = req.body;

    if (!driveUrl) {
        return res.status(400).json({ error: 'رابط ملف Google Drive مطلوب لإتمام الفحص.' });
    }

    const fileId = extractDriveFileId(driveUrl);
    if (!fileId) {
        return res.status(400).json({ error: 'تعذر استخراج المعرف (File ID) من الرابط المقدم.' });
    }

    // سقف أمان الذاكرة: 15 ميغابايت كحد أقصى لمنع انهيار السيرفر مع الملفات الكبيرة
    const MAX_FILE_SIZE = 15 * 1024 * 1024; 
    let base64Pdf = null;
    
    // 1. جلب ورقة الامتحان من خوادم Google Drive مع حماية المهلة (Timeout Protection)
    // تم رفع المهلة إلى 35 ثانية لتعويض بطء استيقاظ السيرفر (Cold Start)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    try {
        const directExportUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        const pdfResponse = await fetch(directExportUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!pdfResponse.ok) {
            console.warn(`❌ [Drive Fetch Error] HTTP Status: ${pdfResponse.status}`);
            return res.status(502).json({ 
                error: `رفضت خوادم Google Drive تزويد الملف (الرمز: ${pdfResponse.status}). قد يكون الرابط خاصاً أو محذوفاً.` 
            });
        }

        // فحص حجم الملف المبدئي من الترويسة إن وجد
        const contentLength = pdfResponse.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
            return res.status(413).json({ error: "حجم ملف ورقة الامتحان يتجاوز الحد المسموح به للتحليل الفوري (15MB)." });
        }

        const arrayBuffer = await pdfResponse.arrayBuffer();
        
        // التحقق الفعلي من حجم البيانات المحملة في الذاكرة
        if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
            return res.status(413).json({ error: "حجم ملف ورقة الامتحان يتجاوز الحد المسموح به للتحليل الفوري (15MB)." });
        }

        base64Pdf = Buffer.from(arrayBuffer).toString('base64');

    } catch (fetchError) {
        clearTimeout(timeoutId);
        console.error("❌ [Drive Fetch Aborted/Failed]:", fetchError.message);
        return res.status(504).json({ 
            error: "استغرق جلب ورقة الامتحان من Google Drive وقتاً أطول من اللازم. يرجى إعادة المحاولة." 
        });
    }

    if (!base64Pdf) {
        return res.status(500).json({ error: "حدث خطأ أثناء معالجة وتحويل بيانات ملف الامتحان بالسيرفر." });
    }

    // 2. صياغة التعليمة الموجهة الصارمة لعزل الموضوع المطلوب وتجنب الهلوسة
    const isTopicOne = (topicNumber === 1 || topicNumber === '1');
    const topicLabel = isTopicOne ? "الموضوع الأول" : "الموضوع الثاني";

    const promptText = `أريدك أن تقدم تصحيحاً مفصلاً ونموذجياً لموضوع البكالوريا التالي:
المادة: ${subject || 'غير محدد'}
الشعبة: ${branchName || 'غير محدد'}
السنة: ${year || 'غير محدد'}
${solutionUrl ? 'رابط التصحيح الوزاري المرجعي للاستئناس بسلم التنقيط: ' + solutionUrl : ''}

📌 [توجيه حاسم ومؤكد]: لقد قمت بإرفاق ملف الـ PDF الفعلي لورقة الأسئلة الرسمية ضمن هذا الطلب. 
اقرأ محتوى الملف المرفق بدقة متناهية، وتجاهل أسئلة الموضوع الآخر تماماً، وركز 100% على استخراج وحل أسئلة "${topicLabel}" فقط لتجنب أي تداخل أو هلوسة.

[تعليمات المنهجية البيداغوجية الصارمة]:
1. اشرح الحل خطوة بخطوة. وضح للمترشح أين تذهب النقاط، وكيف ينتقل من خطوة لأخرى رياضياً أو منطقياً.
2. استخدم رموز LaTeX للمعادلات الرياضية، مثلاً: $x^2$ للمعادلات المدمجة، و $$x^2$$ للمعادلات المستقلة.
3. اتبع أسلوب "الأستاذ قاسم" في الشرح: كن دقيقاً، صارماً في المنهجية، ومشجعاً في نفس الوقت.`;

    const sysInst = "أنت 'الأستاذ قاسم'، أستاذ جزائري مخضرم في لجان تصحيح البكالوريا. قدم تصحيحات نموذجية مفصلة تشرح منهجية الإجابة بأسلوب أكاديمي دقيق ومبسط.";

    // 3. إرسال الطلب لنموذج الرؤية مع نظام التدوير وإعادة المحاولة
    let attempts = 0;
    const maxAttempts = Math.min(apiKeys.length, 5) || 1;
    let lastApiError = "";

    while (attempts < maxAttempts) {
        const activeKey = getNextApiKey();
        try {
            const ai = new GoogleGenAI({ apiKey: activeKey });
            
            const response = await ai.models.generateContent({
                model: 'gemini-1.5-flash', // أو gemini-2.5-flash إن كان متاحاً بمفاتيحك
                config: {
                    systemInstruction: sysInst,
                    temperature: 0.2 // تقليل العشوائية لضمان الصرامة الرياضية والمنطقية
                },
                contents: [{
                    role: 'user', 
                    parts: [
                        { inlineData: { mimeType: "application/pdf", data: base64Pdf } },
                        { text: promptText }
                    ]
                }]
            });
            
            if (!response.text) throw new Error('توليد نصي فارغ من النموذج');

            console.log(`✅ [Correction Success] تم توليد تصحيح ${topicLabel} بنجاح.`);
            return res.json({ correction: response.text });

        } catch (apiError) {
            attempts++;
            lastApiError = apiError.message;
            console.warn(`⚠️ [Correction Attempt #${attempts} Failed]: ${lastApiError}`);
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    // إرجاع تفاصيل الخطأ بدقة للواجهة الأمامية في حال الفشل التام
    if (!res.headersSent) {
        return res.status(500).json({ 
            error: 'تعذر استخراج الحل من محرك الذكاء الاصطناعي.', 
            details: lastApiError || 'استنفدت جميع محاولات الاتصال المتاحة.' 
        });
    }
});

// =========================================================================
// 🌐 تشغيل الخادم
// =========================================================================
app.listen(port, () => {
    console.log(`🚀 السيرفر السحابي يعمل بنجاح على المنفذ ${port}`);
    console.log(`🔑 عدد المفاتيح المحملة والنشطة في الذاكرة: ${apiKeys.length}`);
});
