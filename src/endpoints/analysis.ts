export async function handleAnalyze(request: Request, env: any, corsHeaders: any) {
  try {
    const body = await request.json();
    
    // New format: array of metric objects
    if (!Array.isArray(body) || body.length === 0) {
      return new Response(JSON.stringify({ 
        error: 'Invalid format: expected array of metrics'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Get contentMode from query params or default to "suggestions"
    const url = new URL(request.url);
    const contentMode = url.searchParams.get('contentMode') || 'suggestions';
    
    console.log(`Processing ${body.length} metric sets...`);
    
    // Process ALL metrics, not just the latest one
    const analyses = [];
    
    for (let i = 0; i < body.length; i++) {
      const metric = body[i];
      const heartRate = metric.Pulse || 0;
      const breathRate = metric.Breath || 0;
      const timestamp = metric.Time || 0;
      const imageBase64 = metric.Image || "";
      
      console.log(`Processing metric ${i + 1}/${body.length} - HR: ${heartRate}, BR: ${breathRate}, Time: ${timestamp}`);
      
      // Call Gemini for each metric set
      const analysisResult = await analyzeWithGemini(
        heartRate,
        breathRate,
        imageBase64,
        contentMode,
        env
      );
      
      if (!analysisResult.success) {
        // If one fails, return error for that specific metric
        analyses.push({
          error: analysisResult.error,
          timestamp: timestamp,
          metrics: {
            heartRate,
            breathRate
          }
        });
      } else {
        analyses.push({
          analysis: analysisResult.analysis,
          expression: analysisResult.expression,
          timestamp: timestamp,
          metrics: {
            heartRate,
            breathRate
          }
        });
      }
    }
    
    return new Response(JSON.stringify({ 
      results: analyses,
      totalProcessed: body.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error in handleAnalyze:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function analyzeWithGemini(
  heartRate: number,
  breathRate: number,
  imageBase64: string,
  contentMode: string,
  env: any
) {
  try {
    // Build prompt for Gemini with vision
    const prompt = buildVisionPrompt(heartRate, breathRate, contentMode);
    
    // Prepare request body with image
    const requestBody: any = {
      contents: [{
        parts: [
          { text: prompt }
        ]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 100,  // Reduced from 200 to force brevity
      }
    };
    
    // Add image if provided
    if (imageBase64 && imageBase64.length > 0) {
      // Remove data URL prefix if present (data:image/jpeg;base64,)
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
      
      requestBody.contents[0].parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: cleanBase64
        }
      });
    }
    
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      }
    );
    
    const responseText = await geminiResponse.text();
    
    if (!geminiResponse.ok) {
      return {
        success: false,
        error: `Gemini API error: ${geminiResponse.status} ${geminiResponse.statusText}`,
        details: responseText
      };
    }
    
    const geminiData: any = JSON.parse(responseText);
    
    if (!geminiData.candidates || !geminiData.candidates[0]?.content?.parts?.[0]?.text) {
      return {
        success: false,
        error: 'Invalid response from Gemini API',
        details: JSON.stringify(geminiData)
      };
    }
    
    const fullText = geminiData.candidates[0].content.parts[0].text.trim();
    
    // Extract expression from the full text
    const expression = extractExpression(fullText);
    
    // Remove the emotion word from the beginning of the analysis
    // Format is: "Emotion. Rest of text."
    let analysisText = fullText;
    const parts = fullText.split('.');
    if (parts.length > 1) {
      // Remove first part (emotion word) and keep the rest
      analysisText = parts.slice(1).join('.').trim();
    }
    
    return {
      success: true,
      analysis: analysisText,
      expression: expression
    };
    
  } catch (error) {
    console.error('Error in analyzeWithGemini:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

function extractExpression(analysisText: string): string {
  // Extract emotion keywords from Gemini's response
  const emotionKeywords = [
    'happy', 'sad', 'angry', 'anxious', 'worried', 'confused', 
    'neutral', 'calm', 'stressed', 'surprised', 'surprise', 'fearful', 
    'disgusted', 'content', 'frustrated', 'concerned', 'excited',
    'disappointed', 'scared', 'afraid', 'cheerful', 'joyful'
  ];
  
  const lowerText = analysisText.toLowerCase().trim();
  
  // Strategy 1: Check if the first word (before period or comma) is an emotion
  const firstWord = lowerText.split(/[.,\s]/)[0];
  if (emotionKeywords.includes(firstWord)) {
    return firstWord;
  }
  
  // Strategy 2: Look for emotion in the first sentence
  const firstSentence = lowerText.split('.')[0];
  for (const emotion of emotionKeywords) {
    if (firstSentence.includes(emotion)) {
      return emotion;
    }
  }
  
  // Strategy 3: Search the entire text
  for (const emotion of emotionKeywords) {
    if (lowerText.includes(emotion)) {
      return emotion;
    }
  }
  
  // Fallback: return 'neutral' only if nothing found
  return 'neutral';
}

function buildVisionPrompt(heartRate: number, breathRate: number, contentMode: string) {
  const metrics = `Heart rate: ${heartRate} bpm, Breathing rate: ${breathRate} breaths/min`;
  
  if (contentMode === 'facts') {
    return `You are an emotion analysis assistant for neurodivergent individuals. 
Analyze the person's facial expression in the image along with these biometric readings: ${metrics}.

CRITICAL INSTRUCTIONS:
1. Start with ONLY ONE emotion word from this list: happy, sad, angry, anxious, worried, confused, neutral, calm, stressed, surprised, fearful, disgusted, content, frustrated, concerned, excited
2. After the emotion word, add a period, then write ONE very short sentence (max 10 words) with a factual observation

Format: [Emotion]. [Short observation.]

Example: "Anxious. Heart rate elevated, showing signs of stress."
Example: "Calm. Steady breathing indicates relaxation."
Example: "Surprised. Eyes wide, slight elevation in metrics."

Keep it extremely concise.`;
  } else {
    return `You are an empathy coach for neurodivergent individuals. 
Analyze the person's facial expression in the image along with these biometric readings: ${metrics}.

CRITICAL INSTRUCTIONS:
1. Start with ONLY ONE emotion word from this list: happy, sad, angry, anxious, worried, confused, neutral, calm, stressed, surprised, fearful, disgusted, content, frustrated, concerned, excited
2. After the emotion word, add a period, then write ONE very short actionable suggestion (max 10 words)

Format: [Emotion]. [Short suggestion.]

Example: "Anxious. Slow down and check in with them."
Example: "Happy. Continue current approach, they're comfortable."
Example: "Confused. Clarify or rephrase your last statement."

Keep it extremely concise.`;
  }
}

export async function handleTTS(request: Request, env: any, corsHeaders: any) {
  const body = await request.json();
  
  // Check if this is a batch request (array) or single request (object)
  if (Array.isArray(body)) {
    // Batch processing: multiple texts
    return await handleBatchTTS(body, env, corsHeaders);
  } else {
    // Single text processing (backward compatible)
    return await handleSingleTTS(body, env, corsHeaders);
  }
}

async function handleSingleTTS(body: any, env: any, corsHeaders: any) {
  const { text, voice } = body;
  
  if (!text) {
    return new Response(JSON.stringify({ error: 'Text is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  const voiceId = voice || 'pNInz6obpgDQGcFmaJgB';
  
  const elevenLabsResponse = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      })
    }
  );
  
  if (!elevenLabsResponse.ok) {
    const errorText = await elevenLabsResponse.text();
    throw new Error(`ElevenLabs API error: ${elevenLabsResponse.statusText} - ${errorText}`);
  }
  
  const audioBuffer = await elevenLabsResponse.arrayBuffer();
  
  return new Response(audioBuffer, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'audio/mpeg'
    }
  });
}

async function handleBatchTTS(texts: any[], env: any, corsHeaders: any) {
  // texts is an array of objects: [{ text: "...", voice: "...", timestamp: ... }, ...]
  
  if (texts.length === 0) {
    return new Response(JSON.stringify({ error: 'No texts provided' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  console.log(`Processing ${texts.length} TTS requests...`);
  
  const audioResults = [];
  
  for (let i = 0; i < texts.length; i++) {
    const item = texts[i];
    const text = item.text;
    const voice = item.voice || 'pNInz6obpgDQGcFmaJgB';
    const timestamp = item.timestamp || 0;
    
    if (!text) {
      audioResults.push({
        error: 'Text is required',
        timestamp: timestamp
      });
      continue;
    }
    
    console.log(`Processing TTS ${i + 1}/${texts.length} for timestamp ${timestamp}`);
    
    try {
      const elevenLabsResponse = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': env.ELEVENLABS_API_KEY
          },
          body: JSON.stringify({
            text: text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: {
              stability: 0.6,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true
            }
          })
        }
      );
      
      if (!elevenLabsResponse.ok) {
        const errorText = await elevenLabsResponse.text();
        audioResults.push({
          error: `ElevenLabs API error: ${elevenLabsResponse.statusText}`,
          details: errorText,
          timestamp: timestamp
        });
        continue;
      }
      
      const audioBuffer = await elevenLabsResponse.arrayBuffer();
      
      // Convert to base64 so we can return it in JSON
      const base64Audio = arrayBufferToBase64(audioBuffer);
      
      audioResults.push({
        audio: base64Audio,
        timestamp: timestamp,
        contentType: 'audio/mpeg'
      });
      
    } catch (error) {
      console.error(`Error processing TTS for timestamp ${timestamp}:`, error);
      audioResults.push({
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: timestamp
      });
    }
  }
  
  return new Response(JSON.stringify({
    results: audioResults,
    totalProcessed: texts.length
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Helper function to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function handleSummary(request: Request, env: any, corsHeaders: any) {
  const body = await request.json();
  
  if (!Array.isArray(body) || body.length === 0) {
    return new Response(JSON.stringify({ 
      summary: "No data was collected during this session." 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  // Build summary of session
  const eventsSummary = body.map((metric: any, i: number) => {
    const hr = metric.Pulse || 'N/A';
    const br = metric.Breath || 'N/A';
    const time = metric.Time?.toFixed(2) || 'N/A';
    return `Time ${time}s: HR ${hr}bpm, BR ${br}/min`;
  }).join('\n');
  
  // Calculate statistics
  const avgHeartRate = body.reduce((sum: number, m: any) => sum + (m.Pulse || 0), 0) / body.length;
  const maxHeartRate = Math.max(...body.map((m: any) => m.Pulse || 0));
  const minHeartRate = Math.min(...body.map((m: any) => m.Pulse || 0));
  
  const summaryPrompt = `You are a compassionate conversation analyst helping neurodivergent individuals. 
A person just completed a conversation where their biometric data was tracked. Here are the readings:

${eventsSummary}

Statistics:
- Session duration: ${body.length} data points collected over ${body[body.length - 1].Time.toFixed(0)} seconds
- Average heart rate: ${avgHeartRate.toFixed(1)} bpm
- Heart rate range: ${minHeartRate}-${maxHeartRate} bpm

Provide a supportive 3-4 sentence summary that includes:
1. Overall patterns observed during the conversation (e.g., stable, fluctuating, trending up/down)
2. Any notable moments where metrics changed significantly
3. One constructive suggestion for navigating similar conversations in the future

Be kind, encouraging, and practical.`;

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: summaryPrompt }]
        }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 300
        }
      })
    }
  );
  
  if (!geminiResponse.ok) {
    const errorText = await geminiResponse.text();
    throw new Error(`Gemini API error: ${geminiResponse.statusText} - ${errorText}`);
  }
  
  const geminiData: any = await geminiResponse.json();
  
  if (!geminiData.candidates || !geminiData.candidates[0]?.content?.parts?.[0]?.text) {
    throw new Error('Invalid response from Gemini API');
  }
  
  const summary = geminiData.candidates[0].content.parts[0].text;
  
  return new Response(JSON.stringify({ 
    summary,
    eventCount: body.length,
    duration: body[body.length - 1].Time,
    statistics: {
      avgHeartRate: avgHeartRate.toFixed(1),
      maxHeartRate,
      minHeartRate
    }
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}