import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log('Gemini API Key:', apiKey ? apiKey.substring(0, 10) + '...' : 'none');
  
  if (!apiKey) {
    console.error('No API key found in .env');
    return;
  }
  
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash"
      // no tools
    });
    
    console.log('Sending prompt to Gemini WITHOUT Search...');
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Hello! Are you working?' }] }]
    });
    
    console.log('Response:');
    console.log(result.response.text());
  } catch (err) {
    console.error('Gemini API call failed:', err);
  }
}
run();
