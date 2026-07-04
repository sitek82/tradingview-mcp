/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  // study.setInputValues() is a no-op in this API version regardless of payload shape
  // ({id,value} pairs or positional arrays) — getInputValues() also always returns [].
  // The only reliable way to change inputs is to remove the study and recreate it with
  // a positional array (matching getInputsInfo() order), same as chart.js's manageIndicator.
  // Caveat: any input not present in `overrides` is reset to its factory default, since
  // there is no way to read the study's currently-applied values back out.
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var meta = chart.getAllStudies().find(function(s) { return s.id === ${safeString(entity_id)}; });
      if (!meta) return { error: 'Study metadata not found: ' + ${safeString(entity_id)} };
      var info = study.getInputsInfo();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      var positional = info.map(function(inp) {
        if (overrides.hasOwnProperty(inp.id)) { updatedKeys[inp.id] = overrides[inp.id]; return overrides[inp.id]; }
        return inp.defval;
      });
      var before = chart.getAllStudies().map(function(s) { return s.id; });
      chart.removeEntity(${safeString(entity_id)});
      chart.createStudy(meta.name, false, false, positional);
      return { updatedKeys: updatedKeys, before: before };
    })()
  `);

  if (result && result.error) throw new Error(result.error);

  await new Promise(r => setTimeout(r, 1500));
  const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
  const newIds = (after || []).filter(id => !(result.before || []).includes(id));

  return {
    success: newIds.length > 0,
    entity_id: newIds[0] || null,
    previous_entity_id: entity_id,
    updated_inputs: result.updatedKeys,
    note: 'The study was recreated to apply new inputs, so entity_id changed. Inputs not passed here were reset to factory defaults.',
  };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
