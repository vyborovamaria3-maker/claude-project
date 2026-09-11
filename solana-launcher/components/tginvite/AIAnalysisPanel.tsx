"use client";

import { useState, useCallback } from "react";
import {
  Brain,
  Sparkles,
  TrendingUp,
  Users,
  MessageSquare,
  BarChart3,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Clock,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface ChannelAnalysis {
  username: string;
  score: number;
  sentiment: "positive" | "neutral" | "negative";
  topics: string[];
  engagement: number;
  authenticity: number;
  riskLevel: "low" | "medium" | "high";
  recommendations: string[];
}

interface AIInsights {
  summary: string;
  bestTimeToPost: string;
  targetAudience: string;
  contentStrategy: string;
  growthPotential: number;
}

export default function AIAnalysisPanel() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyses, setAnalyses] = useState<ChannelAnalysis[]>([]);
  const [insights, setInsights] = useState<AIInsights | null>(null);
  const [selectedModel, setSelectedModel] = useState<"gpt4" | "claude" | "local">("gpt4");

  const analyzeChannels = useCallback(async () => {
    setIsAnalyzing(true);

    // Simulate AI analysis
    await new Promise((r) => setTimeout(r, 2000));

    const mockAnalyses: ChannelAnalysis[] = [
      {
        username: "@crypto_signals",
        score: 92,
        sentiment: "positive",
        topics: ["Crypto", "Trading", "Signals"],
        engagement: 0.85,
        authenticity: 0.94,
        riskLevel: "low",
        recommendations: ["High quality channel", "Active community", "Good engagement rate"],
      },
      {
        username: "@defi_gems",
        score: 78,
        sentiment: "neutral",
        topics: ["DeFi", "Tokens", "Airdrops"],
        engagement: 0.72,
        authenticity: 0.81,
        riskLevel: "medium",
        recommendations: ["Moderate activity", "Some bot activity detected", "Verify members manually"],
      },
      {
        username: "@solana_alpha",
        score: 88,
        sentiment: "positive",
        topics: ["Solana", "NFT", "Launches"],
        engagement: 0.91,
        authenticity: 0.89,
        riskLevel: "low",
        recommendations: ["Excellent engagement", "Real users", "High conversion potential"],
      },
    ];

    const mockInsights: AIInsights = {
      summary: "Based on analysis of 3 channels with 45,000+ total members, the optimal strategy is to focus on crypto and Solana-related communities with high engagement rates.",
      bestTimeToPost: "UTC 14:00-18:00 (peak activity)",
      targetAudience: "Crypto enthusiasts, 25-45 age group, English-speaking",
      contentStrategy: "Mix educational content with alpha calls. Use memes for engagement.",
      growthPotential: 87,
    };

    setAnalyses(mockAnalyses);
    setInsights(mockInsights);
    setIsAnalyzing(false);
  }, []);

  return (
    <div className="space-y-6">
      {/* AI Header */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Brain className="h-5 w-5 text-purple-400" />
            AI Channel Analysis
          </h3>
          <div className="flex items-center gap-2">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value as "gpt4" | "claude" | "local")}
              className={siteDesign.controls.inputClassName + " w-40"}
            >
              <option value="gpt4">GPT-4o</option>
              <option value="claude">Claude 3.5</option>
              <option value="local">Local LLM</option>
            </select>
            <button
              onClick={analyzeChannels}
              disabled={isAnalyzing}
              className={siteDesign.controls.primaryActionClassName}
            >
              {isAnalyzing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {isAnalyzing ? "Analyzing..." : "Analyze Channels"}
            </button>
          </div>
        </div>

        <p className="text-sm text-content-muted">
          AI-powered analysis of channel quality, engagement, and growth potential.
        </p>
      </div>

      {/* Analysis Results */}
      {analyses.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {analyses.map((analysis, i) => (
            <div
              key={i}
              className={`${siteDesign.page.panelClassName} ${
                analysis.riskLevel === "high"
                  ? "!border-red-500/30"
                  : analysis.riskLevel === "medium"
                  ? "!border-yellow-500/30"
                  : "!border-green-500/30"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium">{analysis.username}</span>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                    analysis.score >= 80
                      ? "bg-green-500/20 text-green-400"
                      : analysis.score >= 60
                      ? "bg-yellow-500/20 text-yellow-400"
                      : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {analysis.score}/100
                </span>
              </div>

              <div className="space-y-3">
                {/* Sentiment */}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-content-muted">Sentiment</span>
                  <span
                    className={`capitalize ${
                      analysis.sentiment === "positive"
                        ? "text-green-400"
                        : analysis.sentiment === "negative"
                        ? "text-red-400"
                        : "text-yellow-400"
                    }`}
                  >
                    {analysis.sentiment}
                  </span>
                </div>

                {/* Engagement */}
                <div>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-content-muted">Engagement</span>
                    <span>{(analysis.engagement * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-bg-elevated rounded-full">
                    <div
                      className="h-full bg-blue-400 rounded-full"
                      style={{ width: `${analysis.engagement * 100}%` }}
                    />
                  </div>
                </div>

                {/* Authenticity */}
                <div>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-content-muted">Authenticity</span>
                    <span>{(analysis.authenticity * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-bg-elevated rounded-full">
                    <div
                      className="h-full bg-purple-400 rounded-full"
                      style={{ width: `${analysis.authenticity * 100}%` }}
                    />
                  </div>
                </div>

                {/* Topics */}
                <div className="flex flex-wrap gap-1">
                  {analysis.topics.map((topic, j) => (
                    <span key={j} className="px-2 py-0.5 bg-[color:var(--theme-primary)]/10 text-[color:var(--theme-primary)] rounded text-xs">
                      {topic}
                    </span>
                  ))}
                </div>

                {/* Risk Level */}
                <div className="flex items-center gap-2 text-sm">
                  {analysis.riskLevel === "low" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-400" />
                  ) : analysis.riskLevel === "medium" ? (
                    <AlertTriangle className="h-4 w-4 text-yellow-400" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-red-400" />
                  )}
                  <span className="capitalize">{analysis.riskLevel} risk</span>
                </div>

                {/* Recommendations */}
                <div className="text-xs text-content-muted space-y-1">
                  {analysis.recommendations.map((rec, j) => (
                    <div key={j} className="flex items-start gap-1">
                      <span>•</span>
                      <span>{rec}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* AI Insights */}
      {insights && (
        <div className={siteDesign.page.panelClassName}>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Brain className="h-5 w-5 text-[color:var(--theme-primary)]" />
            AI Insights & Recommendations
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="p-4 bg-bg-elevated rounded-lg">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-[color:var(--theme-secondary)]" />
                  Summary
                </h4>
                <p className="text-sm text-content-muted">{insights.summary}</p>
              </div>

              <div className="p-4 bg-bg-elevated rounded-lg">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-[color:var(--theme-tertiary)]" />
                  Best Time to Post
                </h4>
                <p className="text-sm text-content-muted">{insights.bestTimeToPost}</p>
              </div>

              <div className="p-4 bg-bg-elevated rounded-lg">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <Users className="h-4 w-4 text-green-400" />
                  Target Audience
                </h4>
                <p className="text-sm text-content-muted">{insights.targetAudience}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-bg-elevated rounded-lg">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-blue-400" />
                  Content Strategy
                </h4>
                <p className="text-sm text-content-muted">{insights.contentStrategy}</p>
              </div>

              <div className="p-4 bg-bg-elevated rounded-lg">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-purple-400" />
                  Growth Potential
                </h4>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-3 bg-bg-elevated rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-green-400 to-emerald-500 rounded-full"
                      style={{ width: `${insights.growthPotential}%` }}
                    />
                  </div>
                  <span className="text-lg font-bold text-green-400">{insights.growthPotential}%</span>
                </div>
              </div>

              <button
                onClick={() => alert("AI recommendations applied (placeholder)")}
                className={siteDesign.controls.primaryActionClassName + " w-full"}
              >
                <Zap className="h-4 w-4" />
                Apply AI Recommendations
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
