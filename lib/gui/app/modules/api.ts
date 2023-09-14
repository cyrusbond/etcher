/** This function will :
 * 	- start the ipc server (api)
 *  - spawn the child process (privileged or not)
 *  - wait for the child process to connect to the api
 *  - return a promise that will resolve with the emit function for the api
 */

import * as ipc from 'node-ipc';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as packageJSON from '../../../../package.json';
import * as permissions from '../../../shared/permissions';
import { getAppPath } from '../../../shared/get-app-path';
import * as errors from '../../../shared/errors';

const THREADS_PER_CPU = 16;

// NOTE: Ensure this isn't disabled, as it will cause
// the stdout maxBuffer size to be exceeded when flashing
ipc.config.silent = true;

// There might be multiple Etcher instances running at
// the same time, therefore we must ensure each IPC
// server/client has a different name.
const IPC_SERVER_ID = `etcher-server-${process.pid}`;
const IPC_CLIENT_ID = `etcher-client-${process.pid}`;

ipc.config.id = IPC_SERVER_ID;
ipc.config.socketRoot = path.join(
	process.env.XDG_RUNTIME_DIR || os.tmpdir(),
	path.sep,
);

function writerArgv(): string[] {
	let entryPoint = path.join(getAppPath(), 'generated', 'etcher-util');
	// AppImages run over FUSE, so the files inside the mount point
	// can only be accessed by the user that mounted the AppImage.
	// This means we can't re-spawn Etcher as root from the same
	// mount-point, and as a workaround, we re-mount the original
	// AppImage as root.
	if (os.platform() === 'linux' && process.env.APPIMAGE && process.env.APPDIR) {
		entryPoint = entryPoint.replace(process.env.APPDIR, '');
		return [
			process.env.APPIMAGE,
			'-e',
			`require(\`\${process.env.APPDIR}${entryPoint}\`)`,
		];
	} else {
		return [entryPoint];
	}
}

function writerEnv() {
	return {
		IPC_SERVER_ID,
		IPC_CLIENT_ID,
		IPC_SOCKET_ROOT: ipc.config.socketRoot,
		ELECTRON_RUN_AS_NODE: '1',
		UV_THREADPOOL_SIZE: (os.cpus().length * THREADS_PER_CPU).toString(),
		// This environment variable prevents the AppImages
		// desktop integration script from presenting the
		// "installation" dialog
		SKIP: '1',
		...(process.platform === 'win32' ? {} : process.env),
	};
}

async function spawnChild({ withPrivileges }: { withPrivileges: boolean }) {
	const argv = writerArgv();
	console.log(
		`Spawning command ${
			withPrivileges ? 'with privileges' : 'without privileges'
		}: ${argv.join(' ')}`,
	);
	const env = writerEnv();
	if (withPrivileges) {
		return await permissions.elevateCommand(argv, {
			applicationName: packageJSON.displayName,
			environment: env,
		});
	} else {
		const process = await spawn(argv[0], argv.slice(1), {
			env,
		});
		return { cancelled: false, process };
	}
}

function terminateServer(server: any) {
	// Turns out we need to destroy all sockets for
	// the server to actually close. Otherwise, it
	// just stops receiving any further connections,
	// but remains open if there are active ones.
	// @ts-ignore (no Server.sockets in @types/node-ipc)
	for (const socket of server.sockets) {
		socket.destroy();
	}
	server.stop();
}

// TODO: replace the custom ipc events by one generic "message" for all communication with the backend
function startApiAndSpawnChild({
	apiEvents,
	apiEventHandler,
}: {
	apiEvents: string[];
	apiEventHandler: any;
}): Promise<any> {
	return new Promise((resolve, reject) => {
		ipc.serve();

		// log is special message which brings back the logs from the child process and prints them to the console
		ipc.server.on('log', (message: string) => {
			console.log(message);
		});

		// once api is ready (means child process is connected) we pass the emit and terminate function to the caller
		ipc.server.on('ready', (_: any, socket) => {
			const emit = (channel: string, data: any) => {
				ipc.server.emit(socket, channel, data);
			};
			resolve({ emit, terminateServer: () => terminateServer(ipc.server) });
		});

		// register all the api events we want to track, they will be handled by the apiEventHandler
		apiEvents.forEach((event) => {
			ipc.server.on(event, (payload) =>
				apiEventHandler({ type: event, payload }),
			);
		});

		// on api error we terminate
		ipc.server.on('error', (error: any) => {
			terminateServer(ipc.server);
			const errorObject = errors.fromJSON(error);
			reject(errorObject);
		});

		// when the api is started we spawn the child process
		ipc.server.on('start', async () => {
			try {
				const results = await spawnChild({ withPrivileges: true });
				// this will happen if the child is spawned withPrivileges and privileges has been rejected
				if (results.cancelled) {
					reject();
				}
			} catch (error) {
				reject(error);
			}
		});

		// start the server
		ipc.server.start();
	});
}

export { startApiAndSpawnChild };
