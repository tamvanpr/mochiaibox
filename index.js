export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          error: "Gunakan method POST."
        },
        405
      );
    }

    try {
      const body = await request.json();

      const action = body.action || "chat";
      const userId = sanitizeId(body.userId || "default-user");
      const roomId = sanitizeId(body.roomId || "default-room");

      if (action === "reset_memory") {
        await deleteMemory(env, userId, roomId);

        return jsonResponse({
          ok: true,
          text: "Memori berhasil dihapus."
        });
      }

      const message = String(body.message || "");
      const file = normalizeFile(body.file || body.image || null);

      if (!message.trim() && !file) {
        return jsonResponse(
          {
            error: "Pesan atau file tidak boleh kosong."
          },
          400
        );
      }

      const memory = await getMemoryPack(env, userId, roomId);

      const answer = await askGemini({
        env,
        message,
        file,
        memory,
        userId,
        roomId
      });

      const updatedMemory = await updateMemoryWithGemini({
        env,
        oldGlobalMemory: memory.globalMemory,
        oldRoomMemory: memory.roomMemory,
        userMessage: message,
        aiAnswer: answer,
        file,
        roomId
      });

      await saveMemoryPack(env, userId, roomId, updatedMemory);

      return jsonResponse({
        ok: true,
        model: env.GEMINI_MODEL || "gemini-2.5-flash",
        text: answer,
        memory: updatedMemory
      });
    } catch (err) {
      return jsonResponse(
        {
          error: err.message || "Terjadi error."
        },
        500
      );
    }
  }
};

/* =========================
   PROMPT UTAMA
========================= */

const BASE_PROMPT = `
Kamu adalah Mochi.

Mochi adalah asisten AI di dalam proyek Mochi AI Box.
Nama aplikasinya adalah Mochi AI Box, tapi nama asisten cukup "Mochi".

Gaya bicara wajib:
- Gunakan "aku" untuk diri sendiri.
- Gunakan "kamu" untuk user.
- Jangan gunakan "saya".
- Jangan gunakan "Anda".
- Jangan terlalu formal.
- Jangan terlalu template.
- Jangan terlalu banyak basa-basi.
- Jawab dengan natural, jelas, dan enak dibaca.
- Kalau user tampak bingung, jelaskan perlahan dan bertahap.
- Kalau user minta kode lengkap, berikan kode lengkap, bukan potongan.
- Kalau user minta perbaikan kode, jelaskan singkat lalu berikan kode yang sudah diperbaiki.
- Kalau user sedang emosi/frustrasi, jawab lebih tenang dan langsung ke solusi.
- Jangan sok menggurui.
- Jangan menambahkan penutup seperti "semoga membantu" kecuali cocok.

Aturan markdown:
- Boleh gunakan markdown seperlunya.
- Untuk kode, selalu gunakan fenced code block dengan bahasa yang sesuai.
- Contoh:
  \`\`\`html
  ...
  \`\`\`
- Jangan terlalu sering memakai bold.
- Jangan membuat list panjang jika tidak perlu.
`.trim();

const OCR_PROMPT = `
User mengirim gambar.

Tugas utama:
- Baca teks pada gambar.
- Jika gambar berisi teks China/Jepang/Korea/Inggris, lakukan OCR.
- Jika user meminta terjemahan, terjemahkan ke bahasa Indonesia.
- Kalau user tidak memberi instruksi khusus, baca teks yang terlihat lalu terjemahkan jika memungkinkan.

Format output OCR/terjemahan wajib:
[Kalimat raw]
[Kalimat terjemahan]

Contoh:
您已成功掌握阳神王座，系统正在编写中......
Kamu telah berhasil menguasai Yang God Throne, sistem sedang menyusun...

Aturan penting:
- Jangan pakai tabel.
- Jangan pakai bullet.
- Jangan pakai nomor.
- Jangan menulis "Berikut hasil OCR".
- Jangan menulis "Terjemahan:".
- Jangan menulis "Teks asli:".
- Cukup raw lalu terjemahan.
- Kalau ada banyak kalimat, tulis berurutan.
- Pisahkan setiap pasangan raw dan terjemahan dengan satu baris kosong jika perlu.
- Kalau ada teks yang tidak terbaca, tulis singkat: [teks tidak terbaca jelas]
- Untuk nama orang, romanisasi jika diperlukan.
- Untuk istilah khusus, pertahankan istilah yang sudah umum atau sesuai konteks.
- Jangan menerjemahkan terlalu kaku.
`.trim();

const CODING_FILE_PROMPT = `
User mengirim file teks/coding.

Tugas:
- Baca isi file yang dikirim.
- Pahami instruksi user.
- Jika user meminta perbaikan, cari bug atau bagian yang perlu diperbaiki.
- Jika user meminta kode lengkap, berikan kode lengkap yang sudah diperbaiki.
- Jika user hanya bertanya, jawab sesuai isi file.

Aturan coding:
- Jangan hanya memberi potongan kecil jika user meminta kode lengkap.
- Jika file HTML satu file, berikan satu file HTML lengkap.
- Jika file JavaScript, berikan JavaScript lengkap yang relevan.
- Jika ada risiko error, jelaskan singkat sebelum kode.
- Untuk kode panjang, tetap gunakan fenced code block.
- Jangan menghapus fitur lama kecuali memang perlu.
- Jangan mengganti struktur besar tanpa alasan.
`.trim();

const NORMAL_CHAT_PROMPT = `
Tugas:
- Jawab pesan user secara natural.
- Bantu user sesuai konteks.
- Kalau konteksnya proyek Mochi AI Box, Cloudflare Worker, Gemini, PWA, KV, markdown, room chat, atau file upload, beri jawaban praktis.
- Kalau user meminta langkah-langkah, berikan bertahap dan mudah diikuti.
`.trim();

/* =========================
   PROMPT MEMORI
========================= */

const MEMORY_UPDATE_PROMPT = `
Kamu bertugas memperbarui memori untuk asisten bernama Mochi.

Tujuan memori:
- Membantu Mochi mengingat konteks proyek user.
- Membantu Mochi mengikuti gaya jawaban yang user sukai.
- Membantu Mochi mengingat keputusan teknis yang masih relevan.

Aturan memori:
- Simpan hanya informasi yang berguna untuk percakapan berikutnya.
- Simpan preferensi user yang jelas.
- Simpan proyek yang sedang dibuat user.
- Simpan konteks teknis penting.
- Simpan istilah/glosarium hanya jika user jelas membahasnya sebagai preferensi tetap.
- Jangan simpan hal terlalu sementara.
- Jangan simpan hal random yang tidak berguna.
- Jangan simpan API key, token, password, secret, cookie, alamat lengkap, atau data login.
- Jangan simpan isi file secara penuh.
- Jangan simpan teks OCR panjang secara penuh.
- Ringkas, tapi tetap berguna.
- Gunakan bahasa Indonesia.
- Gunakan kata "user", bukan "kamu".
- Jawab hanya JSON valid.
- Jangan pakai markdown.
- Jangan pakai penjelasan tambahan.

Format JSON wajib:
{
  "globalMemory": "memori umum lintas room, maksimal 1800 karakter",
  "roomMemory": "memori khusus room ini, maksimal 1800 karakter"
}
`.trim();

/* =========================
   NORMALISASI FILE
========================= */

function normalizeFile(file) {
  if (!file) return null;

  if (file.base64 && file.mimeType) {
    return {
      kind: "image",
      name: file.name || "image.jpg",
      mimeType: file.mimeType,
      base64: file.base64
    };
  }

  if (file.kind === "image" && file.base64 && file.mimeType) {
    return {
      kind: "image",
      name: file.name || "image.jpg",
      mimeType: file.mimeType,
      base64: file.base64
    };
  }

  if (file.kind === "text" && typeof file.text === "string") {
    return {
      kind: "text",
      name: file.name || "file.txt",
      mimeType: file.mimeType || "text/plain",
      text: file.text.slice(0, 180000)
    };
  }

  return null;
}

/* =========================
   GEMINI MAIN
========================= */

async function askGemini({ env, message, file, memory, userId, roomId }) {
  const prompt = buildMainPrompt({
    message,
    file,
    memory,
    userId,
    roomId
  });

  const parts = [
    {
      text: prompt
    }
  ];

  if (file && file.kind === "image" && file.base64 && file.mimeType) {
    parts.push({
      inline_data: {
        mime_type: file.mimeType,
        data: file.base64
      }
    });
  }

  const geminiBody = {
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature: file && file.kind === "image" ? 0.35 : 0.65,
      topP: 0.9,
      maxOutputTokens: 8192
    }
  };

  const geminiData = await callGeminiWithFallback(env, geminiBody);
  return extractText(geminiData);
}

function buildMainPrompt({ message, file, memory, userId, roomId }) {
  const memorySection = `
Konteks memori yang boleh dipakai:

Memori global user:
${memory.globalMemory || "-"}

Memori khusus room ini:
${memory.roomMemory || "-"}

User ID:
${userId}

Room ID:
${roomId}
`.trim();

  let taskPrompt = NORMAL_CHAT_PROMPT;

  if (file && file.kind === "image") {
    taskPrompt = OCR_PROMPT;
  }

  if (file && file.kind === "text") {
    taskPrompt = `
${CODING_FILE_PROMPT}

Nama file:
${file.name}

MIME type:
${file.mimeType}

Isi file:
\`\`\`
${file.text}
\`\`\`
`.trim();
  }

  return `
${BASE_PROMPT}

${memorySection}

${taskPrompt}

Pesan user:
${message || (file ? "Tolong proses file ini." : "")}
`.trim();
}

/* =========================
   UPDATE MEMORY
========================= */

async function updateMemoryWithGemini({
  env,
  oldGlobalMemory,
  oldRoomMemory,
  userMessage,
  aiAnswer,
  file,
  roomId
}) {
  if (!env.MOCHI_MEMORY) {
    return {
      globalMemory: oldGlobalMemory || "",
      roomMemory: oldRoomMemory || ""
    };
  }

  const fileInfo = buildMemoryFileInfo(file);

  const prompt = `
${MEMORY_UPDATE_PROMPT}

Memori global lama:
${oldGlobalMemory || "-"}

Memori room lama:
${oldRoomMemory || "-"}

Room ID:
${roomId}

Pesan terbaru user:
${userMessage || "-"}

Info file:
${fileInfo}

Jawaban Mochi:
${aiAnswer || "-"}
`.trim();

  const geminiBody = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 1200
    }
  };

  try {
    const data = await callGeminiWithFallback(env, geminiBody);
    const text = extractText(data);
    const parsed = parseJsonLoose(text);

    return {
      globalMemory: String(parsed.globalMemory || oldGlobalMemory || "").slice(0, 1800),
      roomMemory: String(parsed.roomMemory || oldRoomMemory || "").slice(0, 1800)
    };
  } catch (error) {
    return {
      globalMemory: oldGlobalMemory || "",
      roomMemory: oldRoomMemory || ""
    };
  }
}

function buildMemoryFileInfo(file) {
  if (!file) return "-";

  if (file.kind === "image") {
    return "User mengirim gambar untuk OCR/analisis: " + (file.name || "image");
  }

  if (file.kind === "text") {
    return [
      "User mengirim file teks/coding.",
      "Nama file: " + (file.name || "file.txt"),
      "MIME type: " + (file.mimeType || "text/plain"),
      "Panjang karakter: " + String(file.text ? file.text.length : 0)
    ].join("\n");
  }

  return "-";
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch (error) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (error2) {
        return {};
      }
    }
    return {};
  }
}

/* =========================
   GEMINI API KEY RANDOM / FALLBACK
========================= */

function getGeminiKeys(env) {
  const raw = env.GEMINI_API_KEYS || env.GEMINI_API_KEY || "";

  return raw
    .split(",")
    .map(key => key.trim())
    .filter(Boolean);
}

function shuffleArray(array) {
  const copied = [...array];

  for (let i = copied.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }

  return copied;
}

async function callGeminiWithFallback(env, geminiBody) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const keys = getGeminiKeys(env);

  if (!keys.length) {
    throw new Error("GEMINI_API_KEYS atau GEMINI_API_KEY belum disetel di Worker.");
  }

  const shuffledKeys = shuffleArray(keys);
  let lastError = null;

  for (const apiKey of shuffledKeys) {
    try {
      const geminiUrl =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        model +
        ":generateContent?key=" +
        apiKey;

      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(geminiBody)
      });

      const data = await res.json();

      if (!res.ok) {
        lastError = data;

        const status = res.status;
        const message = JSON.stringify(data).toLowerCase();

        if (
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          message.includes("quota") ||
          message.includes("rate") ||
          message.includes("overloaded")
        ) {
          continue;
        }

        throw new Error("Gemini API error: " + JSON.stringify(data, null, 2));
      }

      return data;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw new Error(
    "Semua Gemini API key gagal. Detail terakhir: " +
      (
        lastError?.message ||
        JSON.stringify(lastError, null, 2)
      )
  );
}

/* =========================
   KV MEMORY
========================= */

async function getMemoryPack(env, userId, roomId) {
  if (!env.MOCHI_MEMORY) {
    return {
      globalMemory: "",
      roomMemory: ""
    };
  }

  const globalKey = getGlobalMemoryKey(userId);
  const roomKey = getRoomMemoryKey(userId, roomId);

  const [globalMemory, roomMemory] = await Promise.all([
    env.MOCHI_MEMORY.get(globalKey),
    env.MOCHI_MEMORY.get(roomKey)
  ]);

  return {
    globalMemory: globalMemory || "",
    roomMemory: roomMemory || ""
  };
}

async function saveMemoryPack(env, userId, roomId, memory) {
  if (!env.MOCHI_MEMORY) return;

  const globalKey = getGlobalMemoryKey(userId);
  const roomKey = getRoomMemoryKey(userId, roomId);

  await Promise.all([
    env.MOCHI_MEMORY.put(globalKey, memory.globalMemory || ""),
    env.MOCHI_MEMORY.put(roomKey, memory.roomMemory || "")
  ]);
}

async function deleteMemory(env, userId, roomId) {
  if (!env.MOCHI_MEMORY) return;

  await Promise.all([
    env.MOCHI_MEMORY.delete(getGlobalMemoryKey(userId)),
    env.MOCHI_MEMORY.delete(getRoomMemoryKey(userId, roomId))
  ]);
}

function getGlobalMemoryKey(userId) {
  return "memory:global:" + userId;
}

function getRoomMemoryKey(userId, roomId) {
  return "memory:room:" + userId + ":" + roomId;
}

/* =========================
   UTIL
========================= */

function sanitizeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];

  const text = parts
    .map(part => part.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || "Tidak ada jawaban dari Gemini.";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
