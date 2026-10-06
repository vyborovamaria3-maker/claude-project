import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    # Database
    DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://ai_reply_guy:secure_password_123@localhost:5432/ai_reply_guy")
    
    # Redis
    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    
    # RabbitMQ
    RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://ai_reply_guy:secure_password_123@localhost:5672/")
    
    # Encryption
    ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY")
    if not ENCRYPTION_KEY or len(ENCRYPTION_KEY) != 32:
        raise ValueError("ENCRYPTION_KEY must be 32 bytes")
    
    # JWT
    JWT_SECRET = os.getenv("JWT_SECRET", "super-secret-jwt-key")
    JWT_ALGORITHM = "HS256"
    
    # Telegram
    TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
    
    # LLM
    LLM_API_KEY = os.getenv("LLM_API_KEY")
    LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openai")
    LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4-turbo")
    LOCAL_MODEL_PATH = os.getenv("LOCAL_MODEL_PATH", "./models/store-v1.gguf")
    
    # Security
    CORS_ORIGINS = ["http://localhost:3000", "http://frontend:3000"]
    DEBUG = os.getenv("DEBUG", "False") == "True"
    ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
    
    # Rate Limiting
    DEFAULT_RATE_PER_HOUR = 15
    MAX_RATE_PER_HOUR = 30
    
    # Sleep Mode
    SLEEP_START = os.getenv("SLEEP_START", "01:00")
    SLEEP_END = os.getenv("SLEEP_END", "08:00")
    TIMEZONE = os.getenv("TIMEZONE", "UTC")
    
    # Worker Settings
    WORKER_TIMEOUT = 300  # 5 minutes
    WORKER_HEARTBEAT = 30  # 30 seconds
    
settings = Settings()
