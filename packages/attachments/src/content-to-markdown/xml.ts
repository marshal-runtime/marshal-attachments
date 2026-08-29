import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const parser = new DOMParser();
const serializer = new XMLSerializer();

export function parseXml(xml: string): Document {
	return parser.parseFromString(xml, 'application/xml');
}

export function serializeXml(document: Document): string {
	return serializer.serializeToString(document);
}

export function localNameOf(node: Node | null | undefined): string {
	if (!node || typeof node.nodeName !== 'string') {
		return '';
	}
	return node.nodeName.includes(':')
		? node.nodeName.split(':').at(-1) ?? ''
		: node.nodeName;
}

export function childElements(node: Node | null | undefined): Element[] {
	if (!node || !('childNodes' in node) || !node.childNodes) {
		return [];
	}
	const elements: Element[] = [];
	for (let index = 0; index < node.childNodes.length; index += 1) {
		const child = node.childNodes.item(index);
		if (child?.nodeType === child.ELEMENT_NODE) {
			elements.push(child as Element);
		}
	}
	return elements;
}

export function firstChildByLocalName(node: Node | null | undefined, name: string): Element | undefined {
	return childElements(node).find((child) => localNameOf(child) === name);
}

export function descendantsByLocalName(node: Node | null | undefined, name: string): Element[] {
	const matches: Element[] = [];
	for (const child of childElements(node)) {
		if (localNameOf(child) === name) {
			matches.push(child);
		}
		matches.push(...descendantsByLocalName(child, name));
	}
	return matches;
}

export function getAttribute(node: Element | null | undefined, attributeName: string): string | undefined {
	if (!node) {
		return undefined;
	}
	for (let index = 0; index < node.attributes.length; index += 1) {
		const attribute = node.attributes.item(index);
		if (!attribute) {
			continue;
		}
		const localName = attribute.name.includes(':')
			? attribute.name.split(':').at(-1) ?? attribute.name
			: attribute.name;
		if (attribute.name === attributeName || localName === attributeName) {
			return attribute.value;
		}
	}
	return undefined;
}

export function textContentOf(node: Node | null | undefined): string {
	if (!node) {
		return '';
	}
	return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}
