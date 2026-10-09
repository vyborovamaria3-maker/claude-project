import { q } from "./pg";

export async function buildTrainingData(horizon = 6, step = 12): Promise<number> {
  const r = await q<{ build_training_data: number }>(`SELECT build_training_data($1, $2)`, [horizon, step]);
  return r[0]?.build_training_data ?? 0;
}

export async function trainModel(name: string, horizon = 6): Promise<number> {
  const r = await q<{ train_logistic_regression: string }>(
    `SELECT train_logistic_regression($1, $2, 0.01, 500, 0.001)`, [name, horizon]
  );
  return Number(r[0]?.train_logistic_regression ?? 0);
}

export interface MlModel {
  id: string; name: string; horizon_h: number; target_name: string;
  train_samples: number; train_accuracy: string; train_logloss: string;
  test_samples: number; test_accuracy: string; test_logloss: string;
  is_active: boolean; trained_at: string;
}

export async function listModels(limit = 20): Promise<MlModel[]> {
  return q<MlModel>(
    `SELECT id::text, name, horizon_h, target_name, train_samples, train_accuracy::text, train_logloss::text,
            test_samples, test_accuracy::text, test_logloss::text, is_active, trained_at::text
     FROM ml_models ORDER BY trained_at DESC LIMIT $1`, [limit]
  );
}

export async function predictMint(mint: string, horizon = 6) {
  return q(
    `SELECT mint, probability AS views_growth_50_probability,
            prediction AS predicts_views_growth_50, model_id,
            'observed_dataset_views_growth_50_pct'::TEXT AS target_name
     FROM predict_mint($1, $2)`, [mint, horizon]
  );
}

export async function getCrossMintSignals(limit = 30) {
  return q(`SELECT * FROM v_cross_mint_signals LIMIT $1`, [limit]);
}

export async function getSentimentDivergence(limit = 30) {
  return q(
    `SELECT * FROM v_sentiment_divergence
     WHERE divergence IS NOT NULL
     ORDER BY ABS(divergence) DESC LIMIT $1`, [limit]
  );
}

export async function getTopUltra(limit = 30) {
  return q(
    `SELECT mint, ultra_score::text, hype::text, freshness::text,
            decay::text, divergence::text, lead::text,
            ml_prob::text AS views_growth_50_probability, components
     FROM mint_ultra_scores ORDER BY ultra_score DESC LIMIT $1`, [limit]
  );
}