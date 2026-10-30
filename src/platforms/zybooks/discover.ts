import * as z from 'zod';
import { onAdd, prompt } from '../../discovery.js';
import { api, data, store } from './api.js';

export async function discover() {
	if (!data.user_id) {
		const user_id = await prompt('Enter your user ID: ');
		data.user_id = z.coerce.number().int().parse(user_id.trim());
	}

	if (!data.token) {
		const token = await prompt('Enter your session token: ');
		data.token = token.trim();
	}

	store.update({ user_id: data.user_id, token: data.token });

	let zybooks;

	try {
		const res = await api('GET', `user/${data.user_id}/items?items=["zybooks"]`);
		zybooks = res.items.zybooks;
	} catch (e) {
		if (
			!(e instanceof Error)
			|| (e.message != 'Auth token is expired.' && e.message != 'Your session has expired, please refresh the page.')
		)
			throw e;
		store.update({ token: null });
		return await discover();
	}

	for (const book of zybooks) {
		if (book.autosubscribe || data.books.includes(book.zybook_code)) continue;

		data.books.push(book.zybook_code);
		onAdd('zybook', book.title);
	}

	store.update({ books: data.books });
}
