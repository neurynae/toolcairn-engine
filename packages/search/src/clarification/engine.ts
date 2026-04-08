import type { ToolNode } from '@toolcairn/core';
import type { ClarificationAnswer, ClarificationQuestion } from '../types.js';
import { IG_THRESHOLD, InformationGainCalculator } from './gain.js';
import { getClarificationTemplates } from './templates.js';

const MAX_QUESTIONS_PER_STAGE = 3;

export class ClarificationEngine {
  private readonly calculator = new InformationGainCalculator();
  private readonly templates = getClarificationTemplates();

  /**
   * Return up to MAX_QUESTIONS_PER_STAGE clarification questions for the
   * candidate set, skipping dimensions already asked in this session.
   */
  getClarification(
    candidates: ToolNode[],
    askedDimensions: Set<string> = new Set(),
  ): ClarificationQuestion[] {
    if (candidates.length <= 1) return [];

    const gainMap = this.calculator.compute(candidates);
    const questions: ClarificationQuestion[] = [];

    for (const [dim, gain] of gainMap) {
      if (questions.length >= MAX_QUESTIONS_PER_STAGE) break;
      if (gain < IG_THRESHOLD) break;
      if (askedDimensions.has(dim)) continue;

      const template = this.templates.find((t) => t.dimension === dim);
      if (!template) continue;

      const question = template.buildQuestion(candidates);
      if (question.options.length <= 1) continue;

      questions.push(question);
    }

    return questions;
  }

  /**
   * Filter the candidate set based on submitted clarification answers.
   * Falls back to the full candidate set if answers leave zero results.
   */
  applyAnswers(candidates: ToolNode[], answers: ClarificationAnswer[]): ToolNode[] {
    let filtered = candidates;

    for (const answer of answers) {
      const next = applyAnswer(filtered, answer);
      if (next.length > 0) filtered = next;
    }

    return filtered;
  }
}

function applyAnswer(tools: ToolNode[], answer: ClarificationAnswer): ToolNode[] {
  switch (answer.dimension) {
    case 'topics':
      return tools.filter((t) => (t.topics ?? []).includes(answer.value));
    case 'deployment_model':
      return tools.filter((t) =>
        t.deployment_models.includes(answer.value as ToolNode['deployment_models'][0]),
      );
    case 'language':
      return tools.filter((t) => t.language === answer.value);
    case 'license':
      return tools.filter((t) => t.license === answer.value);
    case 'is_stable': {
      const wantStable = answer.value === 'stable';
      return tools.filter((t) =>
        wantStable ? t.health.maintenance_score >= 0.6 : t.health.maintenance_score < 0.6,
      );
    }
    default:
      return tools;
  }
}
