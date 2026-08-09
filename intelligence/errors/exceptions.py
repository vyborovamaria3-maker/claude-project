"""Domain-specific exceptions for the intelligence pipeline."""


class IntelligenceError(Exception):
    """Base intelligence pipeline error."""


class ProviderError(IntelligenceError):
    """Raised when an external provider fails."""


class StorageError(IntelligenceError):
    """Raised when persistence fails."""


class NormalizationError(IntelligenceError):
    """Raised when source data cannot be normalized."""


class SecurityError(IntelligenceError):
    """Raised when unsafe data is detected."""
