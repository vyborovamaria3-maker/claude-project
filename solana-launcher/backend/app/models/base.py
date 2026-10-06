from sqlalchemy import Column, String, Text, DateTime, Integer, Boolean, ForeignKey, JSON, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime

Base = declarative_base()

class User(Base):
    __tablename__ = 'users'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    telegram_id = Column(BigInteger, unique=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    subscription_status = Column(String(20), default='free')
    subscription_expires_at = Column(DateTime)
    
    # Relationships
    x_accounts = relationship("XAccount", back_populates="user")
    loras = relationship("Lore", back_populates="user")
    alerts = relationship("Alert", back_populates="user")

class XAccount(Base):
    __tablename__ = 'x_accounts'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id'), nullable=False)
    x_username = Column(String(50), nullable=False)
    x_handle = Column(String(50), nullable=False)
    cookies_encrypted = Column(Binary, nullable=False)
    auth_token_encrypted = Column(Binary, nullable=False)
    ct0_encrypted = Column(Binary, nullable=False)
    proxy_encrypted = Column(Binary)
    browser_profile = Column(String(50), default='chrome_windows')
    status = Column(String(20), default='active')
    tier = Column(String(20), default='new')
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_activity_at = Column(DateTime)
    total_tweets_replied = Column(Integer, default=0)
    total_hours_active = Column(Integer, default=0)
    
    # Relationships
    user = relationship("User", back_populates="x_accounts")
    campaign = relationship("Campaign", back_populates="account")
    proxies = relationship("Proxy", back_populates="account")

class Campaign(Base):
    __tablename__ = 'campaigns'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id = Column(UUID(as_uuid=True), ForeignKey('x_accounts.id'), nullable=False)
    lore_id = Column(UUID(as_uuid=True), ForeignKey('loras.id'), nullable=False)
    name = Column(String(100), nullable=False)
    status = Column(String(20), default='inactive')
    settings = Column(JSON, default={})
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    account = relationship("XAccount", back_populates="campaign")
    lore = relationship("Lore", back_populates="campaigns")
    sources = relationship("CampaignSource", back_populates="campaign")
    filters = relationship("CampaignFilter", back_populates="campaign")
    replies = relationship("Reply", back_populates="campaign")

class Lore(Base):
    __tablename__ = 'loras'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id'), nullable=False)
    name = Column(String(100), nullable=False)
    style = Column(Text, nullable=False)
    bio = Column(Text, nullable=False)
    system_prompt = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    user = relationship("User", back_populates="loras")
    examples = relationship("LoreExample", back_populates="lore")
    campaigns = relationship("Campaign", back_populates="lore")

class LoreExample(Base):
    __tablename__ = 'lore_examples'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lore_id = Column(UUID(as_uuid=True), ForeignKey('loras.id'), nullable=False)
    tweet_text = Column(Text, nullable=False)
    reply_text = Column(Text, nullable=False)
    is_deleted = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationships
    lore = relationship("Lore", back_populates="examples")

class Proxy(Base):
    __tablename__ = 'proxies'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id = Column(UUID(as_uuid=True), ForeignKey('x_accounts.id'), nullable=False)
    proxy_encrypted = Column(Binary, nullable=False)
    protocol = Column(String(10), nullable=False)
    host = Column(String(50), nullable=False)
    port = Column(Integer, nullable=False)
    login = Column(String(50))
    password = Column(String(50))
    geo_location = Column(String(20), default='us')
    status = Column(String(20), default='active')
    last_check_at = Column(DateTime)
    latency_ms = Column(Integer)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    account = relationship("XAccount", back_populates="proxies")

class CampaignSource(Base):
    __tablename__ = 'campaign_sources'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey('campaigns.id'), nullable=False)
    type = Column(String(20), nullable=False)  # list, search
    value = Column(String(500), nullable=False)
    priority = Column(Integer, default=5)
    is_deleted = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationships
    campaign = relationship("Campaign", back_populates="sources")

class CampaignFilter(Base):
    __tablename__ = 'campaign_filters'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey('campaigns.id'), nullable=False, unique=True)
    min_age_minutes = Column(Integer, default=1)
    max_age_minutes = Column(Integer, default=10)
    skip_replies = Column(Boolean, default=False)
    skip_retweets = Column(Boolean, default=False)
    skip_quotes = Column(Boolean, default=False)
    min_likes = Column(Integer, default=0)
    min_retweets = Column(Integer, default=0)
    min_followers = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    campaign = relationship("Campaign", back_populates="filters")

class CampaignBlacklist(Base):
    __tablename__ = 'campaign_blacklists'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey('campaigns.id'), nullable=False)
    type = Column(String(20), nullable=False)
    value = Column(String(500), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class Reply(Base):
    __tablename__ = 'replies'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey('campaigns.id'), nullable=False)
    tweet_id = Column(String(50), nullable=False)
    tweet_author = Column(String(50), nullable=False)
    tweet_text = Column(Text, nullable=False)
    reply_text = Column(Text, nullable=False)
    published_at = Column(DateTime)
    status = Column(String(20), default='pending')
    error_message = Column(String(500))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    campaign = relationship("Campaign", back_populates="replies")

class Alert(Base):
    __tablename__ = 'alerts'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id'), nullable=False)
    account_id = Column(UUID(as_uuid=True), ForeignKey('x_accounts.id'))
    type = Column(String(20), nullable=False)
    message = Column(Text, nullable=False)
    read_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationships
    user = relationship("User", back_populates="alerts")
