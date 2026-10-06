from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session
from app.config import settings
from app.models.base import Base
import os

# Database URL
DATABASE_URL = settings.DATABASE_URL

# Create engine
engine = create_engine(DATABASE_URL, pool_size=10, max_overflow=20, pool_pre_ping=True)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Database initialization
def init_db():
    """Initialize database tables"""
    Base.metadata.create_all(bind=engine)
    print("✅ Database tables created successfully")

def drop_all_tables():
    """Drop all tables (for development only)"""
    Base.metadata.drop_all(bind=engine)
    print("⚠️ All database tables dropped")

def reset_database():
    """Fully reset database"""
    drop_all_tables()
    init_db()
    print("✅ Database reset complete")
