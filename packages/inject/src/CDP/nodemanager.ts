import Protocol from "devtools-protocol";
import { SkiBidiMap } from "./util";
type NodeId = Protocol.DOM.NodeId;
type RemoteNode = Protocol.DOM.Node;

export class NodeManager {
	nodes = new SkiBidiMap<NodeId, Node>();
	counter = 0;

	private createId(): NodeId {
		return this.counter++;
	}
	private getOrCreateId(node: Node): NodeId {
		if (this.nodes.getKey(node)) {
			return this.nodes.getKey(node)!;
		} else {
			const id = this.createId();
			this.nodes.set(id, node);
			return id;
		}
	}
	private get(id: NodeId): Node | undefined {
		return this.nodes.get(id);
	}

	wrap(node: Node): RemoteNode {
		const id = this.getOrCreateId(node);
		return {
			nodeId: id,
			nodeName: node.nodeName,
			nodeType: node.nodeType,
			localName: node.localName,
			childNodeCount: node.childNodes.length,
		};
	}
}
