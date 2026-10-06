import openai
import torch
from transformers import pipeline
import numpy as np
from sqlalchemy.orm import Session
from app.models.lore import LoreExample
from app.config import settings

class LLMService:
    """LLM Generation Service"""
    
    def __init__(self, provider: str = "openai", api_key: str = None):
        self.provider = provider
        self.api_key = api_key or settings.LLM_API_KEY
        
        if self.provider == "openai":
            openai.api_key = self.api_key
            self.model = "gpt-4-turbo"
        elif self.provider == "anthropic":
            from anthropic import Anthropic
            self.client = Anthropic(api_key=self.api_key)
            self.model = "claude-3-opus"
        else:
            from llama_cpp import Llama
            self.model = Llama(model_path=settings.LOCAL_MODEL_PATH)
    
    async def generate(self, prompt: str, temperature: float = 0.7) -> str:
        """Main generation interface"""
        if self.provider == "openai":
            return await self._openai_generate(prompt, temperature)
        elif self.provider == "anthropic":
            return await self._anthropic_generate(prompt, temperature)
        else:
            return await self._local_generate(prompt, temperature)
    
    async def _openai_generate(self, prompt: str, temperature: float) -> str:
        """OpenAI GPT-4 generation"""
        response = await openai.ChatCompletion.acreate(
            model=self.model,
            messages=[
                {"role": "system", "content": "You are an AI twitter helper."},
                {"role": "user", "content": prompt}
            ],
            temperature=temperature,
            max_tokens=280,
            n=1
        )
        return response.choices[0].message.content
    
    async def _anthropic_generate(self, prompt: str, temperature: float) -> str:
        """Anthropic Claude generation"""
        message = await self.client.messages.create(
            model=self.model,
            max_tokens=280,
            temperature=temperature,
            system="You are an AI twitter helper.",
            messages=[{"role": "user", "content": prompt}]
        )
        return message.content[0].text
    
    async def _local_generate(self, prompt: str, temperature: float) -> str:
        """Local Llama generation"""
        output = self.model(
            prompt,
            max_tokens=280,
            temperature=temperature,
            top_p=0.9,
            stop=["\n", "\r\n"]
        )
        return output['choices'][0]['text']
    
    async def generate_with_vision(self, prompt: str, image_url: str = None) -> str:
        """Generate with vision capability (for images)"""
        if self.provider == "openai":
            # GPT-4V
            pass
        elif self.provider == "anthropic":
            # Claude 3 with vision
            pass
        else:
            # Local vision models
            pass

class RAGService:
    """RAG Search Service using pgvector"""
    
    def __init__(self, db: Session):
        self.db = db
    
    async def create_embedding(self, text: str) -> list:
        """Generate embedding using sentence transformers"""
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer('all-MiniLM-L6-v2')
        embedding = model.encode([text])[0]
        return embedding.tolist()
    
    async def search_similar(self, query_text: str, top_k: int = 5, threshold: float = 0.7) -> list:
        """Search for similar examples in database"""
        
        # Get embedding
        query_embedding = await self.create_embedding(query_text)
        
        # Query database using pgvector
        from sqlalchemy import text
        query = text("""
            SELECT id, tweet_text, reply_text,
            1 - (embedding <=> :embedding) as similarity
            FROM lore_examples 
            WHERE is_deleted = false
            ORDER BY embedding <=> :embedding
            LIMIT :top_k
        """)
        
        results = self.db.execute(query, {"embedding": query_embedding, "top_k": top_k})
        
        similar = []
        for row in results:
            similarity = row[2]
            if similarity >= threshold:
                similar.append({
                    "id": row[0],
                    "tweet_text": row[1],
                    "reply_text": row[2],
                    "similarity": similarity
                })
        
        return similar

async def generate_reply(tweet: dict, lore: Lore, examples: list) -> str:
    """Main reply generation function"""
    
    # Build prompt with RAG examples
    prompt = f"""
You are a {lore.style}. 

Your bio: {lore.bio}

Current context:
Tweet: {tweet['text']}
Author: {tweet['author']}

Similar situations from your experience:
"""
    
    for i, example in enumerate(examples[:3]):  # Use top 3 examples
        prompt += f"""

EXAMPLE {i+1}:
Original: {example['tweet_text']}
Reply: {example['reply_text']}
"""
    
    prompt += """
Now generate a short, witty reply (under 280 characters) in your character's style.
Be natural, not robotic. No hashtags unless relevant.
"""
    
    llm = LLMService()
    reply = await llm.generate(prompt, temperature=0.7)
    
    # Clean up markdown/formatting
    reply = reply.strip().strip('`').strip('"')
    
    return reply
