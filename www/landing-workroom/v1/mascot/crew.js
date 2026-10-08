/** The four opt-in teammates. This catalog has no renderer or browser dependency. */
export const CREW_ROLES = Object.freeze(['designer', 'researcher', 'developer', 'coordinator']);

export const CREW = Object.freeze({
  designer: Object.freeze({
    id: 'designer', name: 'Designer', label: 'Designer', color: '#ed9957', trim: '#a35932',
    costume: 'Beret, apron and colour swatches',
    description: 'A fresh pair of eyes for your next idea.', workState: 'writing',
  }),
  researcher: Object.freeze({
    id: 'researcher', name: 'Researcher', label: 'Researcher', color: '#64b09d', trim: '#386f61',
    costume: 'Glasses, field vest and notebook',
    description: 'Curious enough to look a little closer.', workState: 'searching',
  }),
  developer: Object.freeze({
    id: 'developer', name: 'Developer', label: 'Developer', color: '#729bdb', trim: '#395b92',
    costume: 'Soft hoodie and laptop',
    description: 'Small steps from an idea to something working.', workState: 'working',
  }),
  coordinator: Object.freeze({
    id: 'coordinator', name: 'Coordinator', label: 'Coordinator', color: '#b39adf', trim: '#705695',
    costume: 'Utility jacket, headset and task board',
    description: 'A little order, and room for what matters.', workState: 'listening',
  }),
});

export function isCrewRole(value) {
  return CREW_ROLES.includes(value);
}
