import OpenAI from "openai";
import * as fs from "node:fs";

const { API_KEY } = process.env;
const { BASE_URL } = process.env;

/**
 * 使用 OpenAI 兼容协议通过第三方代理调用 Gemini 图片生成
 * @param {string} prompt - 图片生成的文字描述
 */
async function gen_image(prompt) {
  const client = new OpenAI({
    apiKey: API_KEY,
    baseURL: BASE_URL,
  });

  const response = await client.chat.completions.create({
    model: "gemini-3.1-flash-image-preview",
    messages: [{ role: "user", content: prompt }],
  });

  const imageData = response.choices[0].message.image?.[0]?.data;
  if (imageData) {
    const buffer = Buffer.from(imageData, "base64");
    fs.writeFileSync("gemini-native-image.png", buffer);
    console.log("Image saved as gemini-native-image.png");
  } else {
    console.log("No image data found in response");
  }
}

// 从命令行参数获取 prompt，默认使用示例 prompt
const prompt = process.argv[2] || "A cute cat wearing a tiny hat";
gen_image(prompt);
