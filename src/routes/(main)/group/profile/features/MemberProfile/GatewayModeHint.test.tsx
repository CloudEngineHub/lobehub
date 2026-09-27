import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import GatewayModeHint from './GatewayModeHint';

let agentConfigs: Record<string, { chatConfig?: { disableGatewayMode?: boolean } }> = {};
let supervisorUsesGateway = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/helpers/gatewayMode', () => ({
  useIsGatewayModeEnabled: () => supervisorUsesGateway,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgentConfigById: (id: string) => () => agentConfigs[id],
  },
}));

describe('GatewayModeHint', () => {
  beforeEach(() => {
    agentConfigs = {};
    supervisorUsesGateway = true;
  });

  it('explains that a member gateway opt-out does not apply in the group', () => {
    agentConfigs = { agt_member: { chatConfig: { disableGatewayMode: true } } };

    render(<GatewayModeHint agentId="agt_member" supervisorAgentId="agt_supervisor" />);

    expect(screen.getByText('group.profile.memberGatewayModeIgnored')).toBeInTheDocument();
  });

  it('stays hidden when the member keeps gateway mode on', () => {
    agentConfigs = { agt_member: { chatConfig: {} } };

    const { container } = render(
      <GatewayModeHint agentId="agt_member" supervisorAgentId="agt_supervisor" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden when the group itself does not run through the gateway', () => {
    agentConfigs = { agt_member: { chatConfig: { disableGatewayMode: true } } };
    supervisorUsesGateway = false;

    const { container } = render(
      <GatewayModeHint agentId="agt_member" supervisorAgentId="agt_supervisor" />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
