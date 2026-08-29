import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '../../../../lib/telegram/agent-manager';

export async function GET() {
  try {
    const agents = agentManager.getAvailableAgents();
    return NextResponse.json({ agents });
  } catch (error) {
    console.error('Error fetching agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}
