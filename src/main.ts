import { MarkdownView, Notice, parseYaml, Plugin, stringifyYaml, TFile, TFolder } from 'obsidian';
import { getDefaultSettings, MediaDbPluginSettings, MediaDbSettingTab } from './settings/Settings';
import { APIManager } from './api/APIManager';
import { MediaTypeModel } from './models/MediaTypeModel';
import { CreateNoteOptions, dateTimeToString, markdownTable, replaceIllegalFileNameCharactersInString, unCamelCase } from './utils/Utils';
import { OMDbAPI } from './api/apis/OMDbAPI';
import { MALAPI } from './api/apis/MALAPI';
import { WikipediaAPI } from './api/apis/WikipediaAPI';
import { MusicBrainzAPI } from './api/apis/MusicBrainzAPI';
import { MEDIA_TYPES, MediaTypeManager } from './utils/MediaTypeManager';
import { SteamAPI } from './api/apis/SteamAPI';
import { BoardGameGeekAPI } from './api/apis/BoardGameGeekAPI';
import { PropertyMapper } from './settings/PropertyMapper';
import { YAMLConverter } from './utils/YAMLConverter';
import { MediaDbFolderImportModal } from './modals/MediaDbFolderImportModal';
import { PropertyMapping, PropertyMappingModel } from './settings/PropertyMapping';
import { ModalHelper, ModalResultCode, SearchModalOptions } from './utils/ModalHelper';

export default class MediaDbPlugin extends Plugin {
	settings: MediaDbPluginSettings;
	apiManager: APIManager;
	mediaTypeManager: MediaTypeManager;
	modelPropertyMapper: PropertyMapper;
	modalHelper: ModalHelper;

	frontMatterRexExpPattern: string = '^(---)\\n[\\s\\S]*?\\n---';

	async onload(): Promise<void> {
		this.apiManager = new APIManager();
		// register APIs
		this.apiManager.registerAPI(new OMDbAPI(this));
		this.apiManager.registerAPI(new MALAPI(this));
		this.apiManager.registerAPI(new WikipediaAPI(this));
		this.apiManager.registerAPI(new MusicBrainzAPI(this));
		this.apiManager.registerAPI(new SteamAPI(this));
		this.apiManager.registerAPI(new BoardGameGeekAPI(this));
		// this.apiManager.registerAPI(new LocGovAPI(this)); // TODO: parse data

		this.mediaTypeManager = new MediaTypeManager();
		this.modelPropertyMapper = new PropertyMapper(this);
		this.modalHelper = new ModalHelper(this);

		await this.loadSettings();
		// register the settings tab
		this.addSettingTab(new MediaDbSettingTab(this.app, this));

		this.mediaTypeManager.updateTemplates(this.settings);
		this.mediaTypeManager.updateFolders(this.settings);

		// add icon to the left ribbon
		const ribbonIconEl = this.addRibbonIcon('database', 'Add new Media DB entry', () => this.createEntryWithAdvancedSearchModal());
		ribbonIconEl.addClass('obsidian-media-db-plugin-ribbon-class');

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem(item => {
						item.setTitle('Import folder as Media DB entries')
							.setIcon('database')
							.onClick(() => this.createEntriesFromFolder(file));
					});
				}
			})
		);

		// register command to open search modal
		this.addCommand({
			id: 'open-media-db-search-modal',
			name: 'Create Media DB entry',
			callback: () => this.createEntryWithSearchModal(),
		});
		for (const mediaType of MEDIA_TYPES) {
			this.addCommand({
				id: `open-media-db-search-modal-with-${mediaType}`,
				name: `Create Media DB entry (${unCamelCase(mediaType)})`,
				callback: () => this.createEntryWithSearchModal({ preselectedTypes: [mediaType] }),
			});
		}
		this.addCommand({
			id: 'open-media-db-advanced-search-modal',
			name: 'Create Media DB entry (advanced search)',
			callback: () => this.createEntryWithAdvancedSearchModal(),
		});
		// register command to open id search modal
		this.addCommand({
			id: 'open-media-db-id-search-modal',
			name: 'Create Media DB entry by id',
			callback: () => this.createEntryWithIdSearchModal(),
		});
		// register command to update the open note
		this.addCommand({
			id: 'update-media-db-note',
			name: 'Update open note (this will recreate the note)',
			checkCallback: (checking: boolean) => {
				if (!this.app.workspace.getActiveFile()) {
					return false;
				}
				if (!checking) {
					this.updateActiveNote(false);
				}
				return true;
			},
		});
		this.addCommand({
			id: 'update-media-db-note-metadata',
			name: 'Update metadata',
			checkCallback: (checking: boolean) => {
				if (!this.app.workspace.getActiveFile()) {
					return false;
				}
				if (!checking) {
					this.updateActiveNote(true);
				}
				return true;
			},
		});
		// register link insert command
		this.addCommand({
			id: 'add-media-db-link',
			name: 'Insert link',
			checkCallback: (checking: boolean) => {
				if (!this.app.workspace.getActiveFile()) {
					return false;
				}
				if (!checking) {
					this.createLinkWithSearchModal();
				}
				return true;
			},
		});
	}

	/**
	 * first very simple approach
	 * TODO:
	 *  - replace the detail query
	 *  - maybe custom link syntax
	 */
	async createLinkWithSearchModal(): Promise<void> {
		const apiSearchResults: MediaTypeModel[] = await this.modalHelper.openAdvancedSearchModal({}, async advancedSearchModalData => {
			return await this.apiManager.query(advancedSearchModalData.query, advancedSearchModalData.apis);
		});

		if (!apiSearchResults) {
			return;
		}

		const selectResults: MediaTypeModel[] = await this.modalHelper.openSelectModal({ elements: apiSearchResults, multiSelect: false }, async selectModalData => {
			return await this.queryDetails(selectModalData.selected);
		});

		if (!selectResults || selectResults.length < 1) {
			return;
		}

		const link = `[${selectResults[0].title}](${selectResults[0].url})`;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		// Make sure the user is editing a Markdown file.
		if (view) {
			view.editor.replaceRange(link, view.editor.getCursor());
		}
	}

	async createEntryWithSearchModal(searchModalOptions?: SearchModalOptions): Promise<void> {
		let types: string[] = [];
		let apiSearchResults: MediaTypeModel[] = await this.modalHelper.openSearchModal(searchModalOptions ?? {}, async searchModalData => {
			types = searchModalData.types;
			const apis = this.apiManager.apis.filter(x => x.hasTypeOverlap(searchModalData.types)).map(x => x.apiName);
			return await this.apiManager.query(searchModalData.query, apis);
		});

		if (!apiSearchResults) {
			// TODO: add new notice saying no results found?
			return;
		}

		// filter the results
		apiSearchResults = apiSearchResults.filter(x => types.contains(x.type));

		let selectResults: MediaTypeModel[];
		let proceed: boolean;

		while (!proceed) {
			selectResults = await this.modalHelper.openSelectModal({ elements: apiSearchResults }, async selectModalData => {
				return await this.queryDetails(selectModalData.selected);
			});
			if (!selectResults) {
				return;
			}

			proceed = await this.modalHelper.openPreviewModal({ elements: selectResults }, async previewModalData => {
				return previewModalData.confirmed;
			});
		}

		await this.createMediaDbNotes(selectResults);
	}

	async createEntryWithAdvancedSearchModal(): Promise<void> {
		const apiSearchResults: MediaTypeModel[] = await this.modalHelper.openAdvancedSearchModal({}, async advancedSearchModalData => {
			return await this.apiManager.query(advancedSearchModalData.query, advancedSearchModalData.apis);
		});

		if (!apiSearchResults) {
			// TODO: add new notice saying no results found?
			return;
		}

		let selectResults: MediaTypeModel[];
		let proceed: boolean;

		while (!proceed) {
			selectResults = await this.modalHelper.openSelectModal({ elements: apiSearchResults }, async selectModalData => {
				return await this.queryDetails(selectModalData.selected);
			});
			if (!selectResults) {
				return;
			}

			proceed = await this.modalHelper.openPreviewModal({ elements: selectResults }, async previewModalData => {
				return previewModalData.confirmed;
			});
		}

		await this.createMediaDbNotes(selectResults);
	}

	async createEntryWithIdSearchModal(): Promise<void> {
		let idSearchResult: MediaTypeModel;
		let proceed: boolean;

		while (!proceed) {
			idSearchResult = await this.modalHelper.openIdSearchModal({}, async idSearchModalData => {
				return await this.apiManager.queryDetailedInfoById(idSearchModalData.query, idSearchModalData.api);
			});
			if (!idSearchResult) {
				return;
			}

			proceed = await this.modalHelper.openPreviewModal({ elements: [idSearchResult] }, async previewModalData => {
				return previewModalData.confirmed;
			});
		}

		await this.createMediaDbNoteFromModel(idSearchResult, { attachTemplate: true, openNote: true });
	}

	async createMediaDbNotes(models: MediaTypeModel[], attachFile?: TFile): Promise<void> {
		for (const model of models) {
			await this.createMediaDbNoteFromModel(model, { attachTemplate: true, attachFile: attachFile });
		}
	}

	async queryDetails(models: MediaTypeModel[]): Promise<MediaTypeModel[]> {
		const detailModels: MediaTypeModel[] = [];
		for (const model of models) {
			try {
				detailModels.push(await this.apiManager.queryDetailedInfo(model));
			} catch (e) {
				console.warn(e);
				new Notice(e.toString());
			}
		}
		return detailModels;
	}

	async createMediaDbNoteFromModel(mediaTypeModel: MediaTypeModel, options: CreateNoteOptions): Promise<void> {
		try {
			console.debug('MDB | creating new note');

			const fileContent = await this.generateMediaDbNoteContents(mediaTypeModel, options);

			if (!options.folder) {
				options.folder = await this.mediaTypeManager.getFolder(mediaTypeModel, this.app);
			}

			await this.createNote(this.mediaTypeManager.getFileName(mediaTypeModel), fileContent, options);
		} catch (e) {
			console.warn(e);
			new Notice(e.toString());
		}
	}

	async generateMediaDbNoteContents(mediaTypeModel: MediaTypeModel, options: CreateNoteOptions): Promise<string> {
		let fileMetadata = this.modelPropertyMapper.convertObject(mediaTypeModel.toMetaDataObject());
		let fileContent = '';
		const template = options.attachTemplate ? await this.mediaTypeManager.getTemplate(mediaTypeModel, this.app) : '';

		({ fileMetadata, fileContent } = await this.attachFile(fileMetadata, fileContent, options.attachFile));
		({ fileMetadata, fileContent } = await this.attachTemplate(fileMetadata, fileContent, template));

		fileContent = `---\n${this.settings.useCustomYamlStringifier ? YAMLConverter.toYaml(fileMetadata) : stringifyYaml(fileMetadata)}---\n` + fileContent;
		return fileContent;
	}

	async attachFile(fileMetadata: any, fileContent: string, fileToAttach?: TFile): Promise<{ fileMetadata: any; fileContent: string }> {
		if (!fileToAttach) {
			return { fileMetadata: fileMetadata, fileContent: fileContent };
		}

		const attachFileMetadata: any = this.getMetadataFromFileCache(fileToAttach);
		fileMetadata = Object.assign(attachFileMetadata, fileMetadata);

		let attachFileContent: string = await this.app.vault.read(fileToAttach);
		const regExp = new RegExp(this.frontMatterRexExpPattern);
		attachFileContent = attachFileContent.replace(regExp, '');
		attachFileContent = attachFileContent.startsWith('\n') ? attachFileContent.substring(1) : attachFileContent;
		fileContent += attachFileContent;

		return { fileMetadata: fileMetadata, fileContent: fileContent };
	}

	async attachTemplate(fileMetadata: any, fileContent: string, template: string): Promise<{ fileMetadata: any; fileContent: string }> {
		if (!template) {
			return { fileMetadata: fileMetadata, fileContent: fileContent };
		}

		const templateMetadata: any = this.getMetaDataFromFileContent(template);
		fileMetadata = Object.assign(templateMetadata, fileMetadata);

		const regExp = new RegExp(this.frontMatterRexExpPattern);
		const attachFileContent = template.replace(regExp, '');
		fileContent += attachFileContent;

		return { fileMetadata: fileMetadata, fileContent: fileContent };
	}

	getMetaDataFromFileContent(fileContent: string): any {
		let metadata: any;

		const regExp = new RegExp(this.frontMatterRexExpPattern);
		const frontMatterRegExpResult = regExp.exec(fileContent);
		if (!frontMatterRegExpResult) {
			return {};
		}
		let frontMatter = frontMatterRegExpResult[0];
		if (!frontMatter) {
			return {};
		}
		frontMatter = frontMatter.substring(4);
		frontMatter = frontMatter.substring(0, frontMatter.length - 3);

		metadata = parseYaml(frontMatter);

		if (!metadata) {
			metadata = {};
		}

		console.debug(`MDB | metadata read from file content`, metadata);

		return metadata;
	}

	getMetadataFromFileCache(file: TFile): any {
		let metadata: any = this.app.metadataCache.getFileCache(file).frontmatter;
		if (metadata) {
			metadata = Object.assign({}, metadata); // copy
			delete metadata.position;
		} else {
			metadata = {};
		}
		return metadata;
	}

	/**
	 * Creates a note in the vault.
	 *
	 * @param fileName
	 * @param fileContent
	 * @param options
	 */
	async createNote(fileName: string, fileContent: string, options: CreateNoteOptions): Promise<void> {
		// find and possibly create the folder set in settings or passed in folder
		const folder = options.folder ?? this.app.vault.getAbstractFileByPath('/');

		fileName = replaceIllegalFileNameCharactersInString(fileName);
		const filePath = `${folder.path}/${fileName}.md`;

		// find and delete file with the same name
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file) {
			await this.app.vault.delete(file);
		}

		// create the file
		const targetFile = await this.app.vault.create(filePath, fileContent);
		console.debug(`MDB | created new file at ${filePath}`);

		// open newly crated file
		if (options.openNote) {
			const activeLeaf = this.app.workspace.getUnpinnedLeaf();
			if (!activeLeaf) {
				console.warn('MDB | no active leaf, not opening newly created note');
				return;
			}
			await activeLeaf.openFile(targetFile, { state: { mode: 'source' } });
		}
	}

	/**
	 * Update the active note by querying the API again.
	 * Tries to read the type, id and dataSource of the active note. If successful it will query the api, delete the old note and create a new one.
	 */
	async updateActiveNote(onlyMetadata: boolean = false): Promise<void> {
		const activeFile: TFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			throw new Error('MDB | there is no active note');
		}

		let metadata: any = this.getMetadataFromFileCache(activeFile);
		metadata = this.modelPropertyMapper.convertObjectBack(metadata);

		console.debug(`MDB | read metadata`, metadata);

		if (!metadata?.type || !metadata?.dataSource || !metadata?.id) {
			throw new Error('MDB | active note is not a Media DB entry or is missing metadata');
		}

		const oldMediaTypeModel = this.mediaTypeManager.createMediaTypeModelFromMediaType(metadata, metadata.type);
		// console.debug(oldMediaTypeModel);

		let newMediaTypeModel = await this.apiManager.queryDetailedInfoById(metadata.id, metadata.dataSource);
		if (!newMediaTypeModel) {
			return;
		}

		newMediaTypeModel = Object.assign(oldMediaTypeModel, newMediaTypeModel.getWithOutUserData());
		// console.debug(newMediaTypeModel);

		// deletion not happening anymore why is this log statement still here
		console.debug('MDB | deleting old entry');
		if (onlyMetadata) {
			await this.createMediaDbNoteFromModel(newMediaTypeModel, { attachFile: activeFile, folder: activeFile.parent, openNote: true });
		} else {
			await this.createMediaDbNoteFromModel(newMediaTypeModel, { attachTemplate: true, folder: activeFile.parent, openNote: true });
		}
	}

	async createEntriesFromFolder(folder: TFolder): Promise<void> {
		const erroredFiles: { filePath: string; error: string }[] = [];
		let canceled: boolean = false;

		const { selectedAPI, titleFieldName, appendContent } = await new Promise<{ selectedAPI: string; titleFieldName: string; appendContent: boolean }>(resolve => {
			new MediaDbFolderImportModal(this.app, this, (selectedAPI: string, titleFieldName: string, appendContent: boolean) => {
				resolve({ selectedAPI, titleFieldName, appendContent });
			}).open();
		});

		for (const child of folder.children) {
			if (child instanceof TFile) {
				const file: TFile = child;
				if (canceled) {
					erroredFiles.push({ filePath: file.path, error: 'user canceled' });
					continue;
				}

				const metadata: any = this.getMetadataFromFileCache(file);

				const title = metadata[titleFieldName];
				if (!title) {
					erroredFiles.push({ filePath: file.path, error: `metadata field '${titleFieldName}' not found or empty` });
					continue;
				}

				let results: MediaTypeModel[] = [];
				try {
					results = await this.apiManager.query(title, [selectedAPI]);
				} catch (e) {
					erroredFiles.push({ filePath: file.path, error: e.toString() });
					continue;
				}
				if (!results || results.length === 0) {
					erroredFiles.push({ filePath: file.path, error: `no search results` });
					continue;
				}

				const { selectModalResult, selectModal } = await this.modalHelper.createSelectModal({ elements: results, skipButton: true, modalTitle: `Results for '${title}'` });

				if (selectModalResult.code === ModalResultCode.ERROR) {
					erroredFiles.push({ filePath: file.path, error: selectModalResult.error.message });
					selectModal.close();
					continue;
				}

				if (selectModalResult.code === ModalResultCode.CLOSE) {
					erroredFiles.push({ filePath: file.path, error: 'user canceled' });
					selectModal.close();
					canceled = true;
					continue;
				}

				if (selectModalResult.code === ModalResultCode.SKIP) {
					erroredFiles.push({ filePath: file.path, error: 'user skipped' });
					selectModal.close();
					continue;
				}

				if (selectModalResult.data.selected.length === 0) {
					erroredFiles.push({ filePath: file.path, error: `no search results selected` });
					continue;
				}

				const detailedResults = await this.queryDetails(selectModalResult.data.selected);
				await this.createMediaDbNotes(detailedResults, appendContent ? file : null);

				selectModal.close();
			}
		}

		if (erroredFiles.length > 0) {
			await this.createErroredFilesReport(erroredFiles);
		}
	}

	async createErroredFilesReport(erroredFiles: { filePath: string; error: string }[]): Promise<void> {
		const title = `MDB - bulk import error report ${dateTimeToString(new Date())}`;
		const filePath = `${title}.md`;

		const table = [['file', 'error']].concat(erroredFiles.map(x => [x.filePath, x.error]));

		const fileContent = `# ${title}\n\n${markdownTable(table)}`;
		await this.app.vault.create(filePath, fileContent);
	}

	async loadSettings(): Promise<void> {
		// console.log(DEFAULT_SETTINGS);
		const diskSettings: MediaDbPluginSettings = await this.loadData();
		const defaultSettings: MediaDbPluginSettings = getDefaultSettings(this);
		const loadedSettings: MediaDbPluginSettings = Object.assign({}, defaultSettings, diskSettings);

		// migrate the settings loaded from the disk to match the structure of the default settings
		const newPropertyMappings: PropertyMappingModel[] = [];
		for (const defaultPropertyMappingModel of defaultSettings.propertyMappingModels) {
			const newPropertyMappingModel: PropertyMappingModel = loadedSettings.propertyMappingModels.find(x => x.type === defaultPropertyMappingModel.type);
			if (newPropertyMappingModel === undefined) {
				// if the propertyMappingModel exists in the default settings but not the loaded settings, add it
				newPropertyMappings.push(defaultPropertyMappingModel);
			} else {
				// if the propertyMappingModel also exists in the loaded settings, add it from there
				const newProperties: PropertyMapping[] = [];

				for (const defaultProperty of defaultPropertyMappingModel.properties) {
					const newProperty = newPropertyMappingModel.properties.find(x => x.property === defaultProperty.property);
					if (newProperty === undefined) {
						// default property is an instance
						newProperties.push(defaultProperty);
					} else {
						// newProperty is just an object and take locked status from default property
						newProperties.push(new PropertyMapping(newProperty.property, newProperty.newProperty, newProperty.mapping, defaultProperty.locked));
					}
				}

				newPropertyMappings.push(new PropertyMappingModel(newPropertyMappingModel.type, newProperties));
			}
		}
		loadedSettings.propertyMappingModels = newPropertyMappings;

		this.settings = loadedSettings;
	}

	async saveSettings(): Promise<void> {
		this.mediaTypeManager.updateTemplates(this.settings);
		this.mediaTypeManager.updateFolders(this.settings);

		await this.saveData(this.settings);
	}
}
