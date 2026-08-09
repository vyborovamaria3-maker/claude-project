from abc import ABC, abstractmethod
from intelligence.core.models import IntelligenceDocument, ProviderHealth


class IntelligenceProvider(ABC):
    name: str = "unknown"

    @abstractmethod
    async def collect(self, query: str) -> list[IntelligenceDocument]:
        raise NotImplementedError

    @abstractmethod
    async def health(self) -> ProviderHealth:
        raise NotImplementedError

    def normalize(self, document: IntelligenceDocument) -> IntelligenceDocument:
        return document
