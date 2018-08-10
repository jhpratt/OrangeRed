import { EventEmitter } from 'events';
import once from 'lodash-decorators/once';
import get from 'lodash.get';
import merge from 'lodash.merge';
import pick from 'lodash.pick';
import nanoid from 'nanoid';
import { AuthOptions, Headers } from 'request';
import request from 'request-promise-native';
import RateLimit from './RateLimit';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

type Scope =
  | 'account'
  | 'creddits'
  | 'edit'
  | 'flair'
  | 'history'
  | 'identity'
  | 'livemanage'
  | 'modconfig'
  | 'modcontributors'
  | 'modflair'
  | 'modlog'
  | 'modmail'
  | 'modothers'
  | 'modposts'
  | 'modself'
  | 'modtraffic'
  | 'modwiki'
  | 'mysubreddits'
  | 'privatemessages'
  | 'read'
  | 'report'
  | 'save'
  | 'structuredstyles'
  | 'submit'
  | 'subscribe'
  | 'vote'
  | 'wikiedit'
  | 'wikiread';

interface RequestOptions {
  [key: string]: unknown;
  domain?: string;
  uri?: string;
  method?: Method;
  headers?: Headers;
  auth?: AuthOptions;
  form?: { [key: string]: unknown };
}

/**
 * Wrapper for Reddit's API, providing minimal functionality.
 * Additional endpoints, if necessary, should not be difficult to implement.
 */
export default class Reddit {
  /**
   * The refresh token used to get a new bearer token.
   * This should be located in persistent storage,
   * and passed to `auth()` as the only parameter to fetch a new bearer token.
   */
  public get refresh_token() {
    return this._refresh_token;
  }

  /**
   * The URI to send the end user to.
   * Includes a unique state, the list of scopes, and duration.
   *
   * Important note: This value changes upon every request.
   */
  public static get auth_url(): string {
    return Reddit.auth_url_and_state()[0];
  }

  /**
   * @param user_agent The user agent to send in the header of each request.
   *   You should include your app's _name_, _version_, and _your username_.
   * @param client_id The client ID provided by Reddit, located directly under
   *   'web app' on [this page](https://www.reddit.com/prefs/apps/).
   * @param secret The app's secret provided by Reddit, visible after clicking
   *   'edit' on [this page](https://www.reddit.com/prefs/apps/).
   * @param redirect_uri The URI to redirect to after authentication (successful
   *   or failed). This must _exactly_ match the URI located in [your app
   *   configuration](https://www.reddit.com/prefs/apps/).
   * @param scopes An array of scopes to be requested. If using TypeScript, the
   *   available scopes are checked at compile time.
   * @param permanent Do you want permanent access to this account (`true`), or
   *   will you ask again in an hour (`false`)? Defaults to permanent.
   */
  @once
  public static configure(
    user_agent: string,
    client_id: string,
    secret: string,
    redirect_uri: string,
    scopes: ReadonlyArray<Scope>,
    permanent = true,
  ) {
    Reddit.user_agent = user_agent;
    Reddit.client_id = client_id;
    Reddit.secret = secret;
    Reddit.redirect_uri = redirect_uri;
    Reddit.scopes = scopes;
    Reddit.permanent = permanent;
  }

  /**
   * The URI to send the end user to, along with a unique state.
   */
  public static auth_url_and_state(): [string, string] {
    const state = nanoid();

    // we only want to allow states that we have knowledge of.
    // must be fulfulled within one hour or it is rejected
    Reddit.pending_auth_states[state] = setTimeout(() => {
      delete Reddit.pending_auth_states[state];
      Reddit.emit('state_expiration', state);
    }, 3_600_000);

    return [
      `https://ssl.reddit.com/api/v1/authorize` +
        `?client_id=${Reddit.client_id}` +
        `&response_type=code` +
        `&state=${state}` +
        `&redirect_uri=${encodeURIComponent(Reddit.redirect_uri)}` +
        `&duration=${Reddit.permanent ? 'permanent' : 'temporary'}` +
        `&scope=${Reddit.scopes.join(',')}`,
      state,
    ];
  }

  /**
   * Let's use an EventEmitter to allow third parties to listen to certain events.
   * This eliminates the need to have hooks.
   */
  private static event_emitter = new EventEmitter();
  public static on = Reddit.event_emitter.on; // tslint:disable-line member-ordering
  private static emit = Reddit.event_emitter.emit;

  /**
   * The user agent to send in the header of each request.
   * You should include your app's _name_, _version_, and _your username_.
   */
  private static user_agent: string;

  /**
   * The client ID provided by Reddit, located directly under
   * 'web app' on [this page](https://www.reddit.com/prefs/apps/).
   */
  private static client_id: string;

  /**
   * The app's secret provided by Reddit, visible after clicking
   * 'edit' on [this page](https://www.reddit.com/prefs/apps/).
   */
  private static secret: string;

  /**
   * The URI to redirect to after authentication (successful
   * or failed). This must _exactly_ match the URI located in [your app
   * configuration](https://www.reddit.com/prefs/apps/).
   */
  private static redirect_uri: string;

  /**
   * An array of scopes to be requested. If using TypeScript, the
   * available scopes are checked at compile time.
   */
  private static scopes: ReadonlyArray<Scope>;

  /**
   * Do you want permanent access to this account (`true`), or
   * will you ask again in an hour (`false`)? Defaults to permanent.
   */
  private static permanent: boolean;

  /**
   * Rate limit all requests to the specified amount.
   * Burst requests are not available — they are fired upon even intervals.
   */
  private static readonly queue = new RateLimit('60 per minute');

  /**
   * Map of pending authentication states to `NodeJS.Timer` objects.
   * The latter deletes itself and the key after one hour,
   * preventing unauthorized states from being passed.
   */
  private static readonly pending_auth_states: {
    [key: string]: NodeJS.Timer;
  } = {};
  private _refresh_token: Option<string>;

  /**
   * The current token used to authenticate with Reddit.
   * Replaced upon expiration; never in persistent storage.
   */
  private bearer_token: Option<string>;

  /**
   * The object from `setTimeout`, set to trigger one minute before token expiration.
   * _Do not modify this variable directly._
   * It should only be set using the response from an API request.
   */
  private refresh_token_timeout: NodeJS.Timer;

  // BEGIN ENDPOINTS

  /**
   * Returns the identity of the user.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#GET_api_v1_me)
   */
  public me(): Promise<any> {
    return this.api_request('/api/v1/me');
  }

  /**
   * Return the preference settings of the logged in user.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#GET_api_v1_me_prefs)
   */
  public prefs(): Promise<any> {
    return this.api_request('/api/v1/me/prefs');
  }

  /**
   * Submit will create a self-post in the provided subreddit with the provided title.
   * `text`, if present, will be the body of the post unless `richtext_json` is present,
   * in which case it will be converted into the body of the post.
   * An error is thrown if both `text` and `richtext_json` are present.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#POST_api_submit)
   *
   * @param subreddit Which subreddit to submit the post to.
   * @param title The title of the post.
   * @param text The text (body) of the post.
   * @param options (all optional) Flair ID, flair text, NSFW, send replies to inbox
   */
  public async submit_text_post(
    subreddit: string,
    title: string,
    text: string,
    options?: {
      flair_id?: string;
      flair_text?: string;
      nsfw?: boolean;
      sendreplies?: boolean;
    },
  ): Promise<{
    url: string;
    drafts_count: number;
    id: string;
    name: string;
    subreddit: string;
    title: string;
    text: string;
  }> {
    const response = await this.api_request('/api/submit', {
      method: 'POST',
      form: {
        kind: 'self',
        api_type: 'json',
        extension: 'json',
        sendreplies: false,
        sr: subreddit,
        text,
        title,
        ...options,
      },
    });

    return {
      ...response,
      subreddit,
      title,
      text,
    };
  }

  /**
   * Edit the body text of a comment or self-post.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#POST_api_editusertext)
   *
   * @param id ID of the post/comment to edit.
   * @param text The text (in markdown) to set.
   */
  public edit(id: string, text: string): Promise<any> {
    return this.api_request('/api/editusertext', {
      method: 'POST',
      form: {
        api_type: 'json',
        thing_id: id,
        text,
      },
    });
  }

  /**
   * Approve a link or comment.
   *
   * If the thing was removed, it will be re-inserted into appropriate listings.
   * Any reports on the approved thing will be discarded.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#POST_api_approve)
   *
   * @param id ID of the post/comment to approve.
   */
  public approve(id: string): Promise<any> {
    return this.api_request('/api/approve', {
      method: 'POST',
      form: {
        id,
      },
    });
  }

  /**
   * Set or unset a post as the sticky in its subreddit.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#POST_api_set_subreddit_sticky)
   *
   * @param id ID of the post to sticky/unsticky.
   * @param state Indicates whether to sticky or unsticky this
   *   post — `true` to sticky, `false` to unsticky.
   */
  public set_sticky(id: string, state: boolean = true): Promise<any> {
    return this.api_request('/api/set_subreddit_sticky', {
      method: 'POST',
      form: {
        api_type: 'json',
        id,
        state,
      },
    });
  }

  // END ENDPOINTS

  /**
   * Clear all information specific to the authenticated user.
   */
  public logout(): void {
    if (this.refresh_token_timeout) {
      clearTimeout(this.refresh_token_timeout);
    }

    this.bearer_token = undefined;
    this._refresh_token = undefined;
  }

  /**
   * @param refresh_token The refresh token to create a session from. Likely in
   *   persistent storage.
   */
  public async auth(refresh_token: string): Promise<this>;
  /**
   * @param options.state The unique state variable in the response. It is not
   *   necessary to check the accuracy of this variable — it is performed
   *   automatically.
   * @param options.code The code variable returned in the response.
   */
  // tslint:disable-next-line unified-signatures
  public async auth(options: { state: string; code: string }): Promise<this>;
  public async auth(
    options: string | { state: string; code: string },
  ): Promise<this> {
    let form;

    // we've been passed a refresh token,
    // _not_ a state and code for first-time authentication
    if (typeof options === 'string') {
      form = {
        grant_type: 'refresh_token',
        refresh_token: (this._refresh_token = options),
      };
    }
    // new authorization, no refresh token
    else {
      // require a state that is pending. if one is not found, reject.
      if (Reddit.pending_auth_states.hasOwnProperty(options.state)) {
        clearTimeout(Reddit.pending_auth_states[options.state]);
        delete Reddit.pending_auth_states[options.state];
        Reddit.emit('state_expiration', options.state);
      } else {
        return Promise.reject('State not found.');
      }

      form = {
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: Reddit.redirect_uri,
      };
    }

    // perform the request
    // if we have a refresh token and the request fails, automatically retry
    let json;
    try {
      json = await this.api_request('/api/v1/access_token', {
        domain: 'https://ssl.reddit.com',
        method: 'POST',
        form,
        in_authorization_flow: true,
      });
    } catch (err) {
      // refresh token, not new authorization
      if (typeof options === 'string') {
        if (err === 'invalid_request') {
          // token is no longer valid, let's log out
          this.logout();
          return this;
        } else {
          // some other error, try again
          this.auth(options);
        }
      }

      throw err;
    }

    // set instance variables from response
    this.bearer_token = json.access_token;
    if (json.refresh_token !== undefined) {
      this._refresh_token = json.refresh_token;
    }

    // let's refresh the token a minute before it expires
    if (this._refresh_token !== undefined && json.expires_in !== undefined) {
      this.refresh_token_timeout = setTimeout(
        () => this.auth(this._refresh_token!),
        json.expires_in * 1_000 - 60_000,
      );
    }

    return this;
  }

  /**
   * @param endpoint The full endpoint, including the leading slash. This will
   *   exactly match the path located on [this page](https://www.reddit.com/dev/api).
   * @param parse_options Any options used when parsing the response. Currently
   *   only the key `json`, which will automatically run the body through
   *   `JSON.parse` if `true`.
   * @param _req_options Any options passed onto the request. Will be merged
   *   with defaults.
   */
  private async api_request(
    endpoint: string,
    _req_options: RequestOptions = {},
    parse_options: { json?: boolean } = { json: true },
  ): Promise<any> {
    const req_options: RequestOptions = merge(
      {
        domain: 'https://oauth.reddit.com',
        method: 'GET',
        headers: {
          'User-Agent': Reddit.user_agent,
        },
      },
      this.bearer_token === undefined
        ? {}
        : { headers: { Authorization: `bearer ${this.bearer_token}` } },
      _req_options,
    );

    // automatically add authentication where necessary
    if (
      req_options.domain !== 'https://www.reddit.com' &&
      !req_options.domain!.startsWith('https://oauth.reddit.com')
    ) {
      req_options.auth = { user: Reddit.client_id, pass: Reddit.secret };
    }

    // this is all we need to do to properly rate limit all requests
    await new Promise(resolve => Reddit.queue.push(resolve));

    // make the request using the appropriate options
    let json = await request({
      uri: `${req_options.domain}${endpoint}`,
      ...pick(req_options, ['method', 'form', 'qs', 'headers', 'auth']),
    });

    // parse the JSON if requested, throwing errors as appropriate
    if (parse_options.json) {
      json = JSON.parse(json);

      if (get(json, 'error')) {
        throw json.error;
      }
      if (get(json, 'json.errors.length')) {
        throw json.json.errors;
      }
      if (get(json, 'success') === false) {
        throw json;
      }

      if (get(json, 'json.data')) {
        json = json.json.data;
      }
    }

    return json;
  }
}
