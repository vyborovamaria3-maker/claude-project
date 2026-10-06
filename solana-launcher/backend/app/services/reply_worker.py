import asyncio
import redis
import json
from datetime import datetime
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.models.x_account import XAccount
from app.models.campaign import Campaign
from app.services.llm import generate_reply, setup_llm
from app.services.rag import search_similar_examples
from app.services.twitter import tweet_reply
from app.services.rate_limit import check_rate_limit
from app.services.mysql import send_to_mysql
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Redis connection
redis_client = redis.Redis(host='localhost', port=6379, db=0)

class ReplyWorker:
    def __init__(self, account_id: str, campaign_id: str):
        self.account_id = account_id
        self.campaign_id = campaign_id
        self.running = False
        
    async def run(self):
        """Main worker loop"""
        self.running = True
        logger.info(f"Worker started for account {self.account_id}")
        
        while self.running:
            try:
                # Check rate limit
                if not await self.check_rate_limit():
                    await asyncio.sleep(30)  # Wait before next check
                    continue
                
                # Get new tweets
                tweets = await self.fetch_new_tweets()
                if not tweets:
                    await asyncio.sleep(30)
                    continue
                
                # Process each tweet
                for tweet in tweets:
                    if await self.should_reply(tweet):
                        await self.reply_to_tweet(tweet)
                
            except Exception as e:
                logger.error(f"Worker error: {e}")
                await asyncio.sleep(5)
    
    async def check_rate_limit(self) -> bool:
        """Check if we can send a reply"""
        rate_limit_key = f"rate_limit:{self.account_id}:{int(datetime.now().timestamp()/3600)}"
        
        count = redis_client.get(rate_limit_key)
        if count is None:
            redis_client.set(rate_limit_key, 0, ex=3600)
            return True
        
        count = int(count)
        # Default 15 replies per hour
        if count >= 15:
            return False
        
        # Increment counter
        redis_client.incr(rate_limit_key)
        return True
    
    async def fetch_new_tweets(self) -> list:
        """Fetch new tweets from campaign sources"""
        # This will query Twitter API or wait for RabbitMQ task
        # For now, simulate getting tweets
        return []
    
    async def should_reply(self, tweet: dict) -> bool:
        """Check if we should reply to this tweet"""
        # Apply filters: age, type, metrics, blacklists
        filters = self.get_campaign_filters()
        # ... implementation ...
        return True
    
    async def reply_to_tweet(self, tweet: dict):
        """Generate and publish reply"""
        
        # Get Lore and examples
        lore = self.get_campaign_lore()
        examples = await search_similar_examples(tweet["text"], top_k=5)
        
        # Generate reply using LLM
        reply = await generate_reply(
            tweet=tweet,
            lore=lore,
            examples=examples
        )
        
        # Post reply
        success = await tweet_reply(
            tweet_id=tweet["id"],
            reply_text=reply,
            account=self.get_account()
        )
        
        if success:
            # Record reply
            await self.record_reply(tweet, reply)
        else:
            # Log failure
            await self.log_failure(tweet, "Reply failed")
    
    async def record_reply(self, tweet: dict, reply: str):
        """Save reply to database"""
        # ... implementation ...
        pass
    
    async def log_failure(self, tweet: dict, error: str):
        """Log failed reply"""
        # ... implementation ...
        pass
    
    def get_campaign_filters(self) -> dict:
        """Get campaign filters"""
        # ... implementation ...
        return {}
    
    def get_campaign_lore(self) -> Lore:
        """Get campaign lore"""
        # ... implementation ...
        return Lore(style="sample", bio="sample")
    
    def get_account(self) -> XAccount:
        """Get x-account credentials"""
        # ... implementation ...
        return XAccount()
    
    async def stop(self):
        """Stop worker gracefully"""
        self.running = False

async def main():
    # Get campaign from database
    async with get_db() as db:
        # This would normally get from DB via RabbitMQ message
        account_id = "test-account"
        campaign_id = "test-campaign"
        
        worker = ReplyWorker(account_id, campaign_id)
        await worker.run()
        
        # Graceful stop
        signal.signal(socket.SIGINT, lambda sig: worker.stop())
        signal.signal(socket.SIGTERM, lambda sig: worker.stop())
        
        # Run until stopped
        while worker.running:
            await asyncio.sleep(1)

if __name__ == "__main__":
    asyncio.run(main())
