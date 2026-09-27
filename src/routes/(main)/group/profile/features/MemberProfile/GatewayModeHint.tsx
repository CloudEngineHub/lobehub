'use client';

import { Icon } from '@lobehub/ui';
import { Alert } from '@lobehub/ui/base-ui';
import { InfoIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsGatewayModeEnabled } from '@/helpers/gatewayMode';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

interface GatewayModeHintProps {
  agentId: string;
  supervisorAgentId?: string;
}

/**
 * Group members always run in the supervisor's runtime, so a member's own
 * `disableGatewayMode` (set from its direct chat) has no effect in the group.
 * Say so where the member is configured instead of ignoring it silently.
 */
const GatewayModeHint = memo<GatewayModeHintProps>(({ agentId, supervisorAgentId }) => {
  const { t } = useTranslation('chat');
  const memberDisabledGateway = useAgentStore(
    (s) => agentByIdSelectors.getAgentConfigById(agentId)(s)?.chatConfig?.disableGatewayMode,
  );
  const supervisorUsesGateway = useIsGatewayModeEnabled(supervisorAgentId);

  if (memberDisabledGateway !== true || !supervisorUsesGateway) return null;

  return (
    <Alert
      icon={<Icon icon={InfoIcon} />}
      style={{ marginBottom: 12, width: '100%' }}
      title={t('group.profile.memberGatewayModeIgnored')}
      type="info"
      variant={'outlined'}
    />
  );
});

GatewayModeHint.displayName = 'GatewayModeHint';

export default GatewayModeHint;
